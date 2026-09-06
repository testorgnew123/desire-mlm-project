// Unit status transitions, blocking, and the delta read that backs the live
// inventory board. Hold-specific operations live in holds.ts.
import type { PrismaClient, Prisma, UnitStatus } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertValidTransition, InvalidTransitionError } from "./unit-transitions";
import { effectiveUnitStatus } from "./holds";

export class UnitBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitBlockError";
  }
}

/** Applies a status transition, writing UnitStatusHistory and an audit row in
 *  the same transaction as the change itself -- a transition and its history
 *  entry must commit or roll back together, never one without the other. */
export async function transitionUnitStatus(
  db: PrismaClient,
  params: {
    unitId: string;
    to: UnitStatus;
    reason?: string;
    audit: AuditContext;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: params.unitId },
      select: { id: true, status: true },
    });
    assertValidTransition(unit.status, params.to);
    await applyTransition(tx, unit.id, unit.status, params.to, params.reason, params.audit);
  });
}

async function applyTransition(
  tx: Prisma.TransactionClient,
  unitId: string,
  from: UnitStatus,
  to: UnitStatus,
  reason: string | undefined,
  audit: AuditContext,
): Promise<void> {
  await tx.unit.update({ where: { id: unitId }, data: { status: to } });
  await tx.unitStatusHistory.create({
    data: {
      unitId,
      fromStatus: from,
      toStatus: to,
      reason,
      actorId: audit.actorId,
      actorLabel: audit.actorLabel,
    },
  });
  await writeAuditLog(tx, audit, {
    action: "UPDATE",
    entity: "Unit",
    entityId: unitId,
    before: { status: from },
    after: { status: to },
    reason,
  });
}

/** Blocking is admin-only with a mandatory reason (docs/06-INVENTORY-SPEC.md).
 *  Any live hold is released as part of the same transaction -- leaving a
 *  hold pointing at a blocked unit would let it look holdable on a stale read. */
export async function blockUnit(
  db: PrismaClient,
  params: { unitId: string; reason: string; audit: AuditContext; now?: Date },
): Promise<void> {
  if (!params.reason?.trim()) {
    throw new UnitBlockError("Blocking a unit requires a reason.");
  }
  const now = params.now ?? new Date();

  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${params.unitId} FOR UPDATE`;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: params.unitId },
      select: { id: true, status: true, currentHoldId: true },
    });
    assertValidTransition(unit.status, "BLOCKED");

    if (unit.currentHoldId) {
      await tx.unitHold.updateMany({
        where: { id: unit.currentHoldId, releasedAt: null },
        data: { releasedAt: now, releaseReason: "UNIT_BLOCKED", releasedById: params.audit.actorId },
      });
    }
    await tx.unit.update({
      where: { id: unit.id },
      data: {
        status: "BLOCKED",
        currentHoldId: null,
        blockReason: params.reason,
        blockedById: params.audit.actorId,
        blockedAt: now,
      },
    });
    await tx.unitStatusHistory.create({
      data: {
        unitId: unit.id,
        fromStatus: unit.status,
        toStatus: "BLOCKED",
        reason: params.reason,
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Unit",
      entityId: unit.id,
      before: { status: unit.status },
      after: { status: "BLOCKED" },
      reason: params.reason,
    });
  });
}

/** Unblocking returns the unit to whatever status it held immediately before
 *  being blocked -- read from UnitStatusHistory, not passed in by the caller,
 *  so an admin can't accidentally "unblock" a sold unit back to AVAILABLE.
 *
 *  One deliberate exception: a unit blocked while HELD returns to AVAILABLE,
 *  not HELD, because blockUnit released that hold. Returning it to HELD would
 *  point at a released hold and make the unit unholdable by anyone. */
export async function unblockUnit(
  db: PrismaClient,
  params: { unitId: string; reason?: string; audit: AuditContext },
): Promise<{ restoredTo: UnitStatus }> {
  return db.$transaction(async (tx) => {
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: params.unitId },
      select: { id: true, status: true },
    });
    if (unit.status !== "BLOCKED") {
      throw new UnitBlockError(`Unit is not blocked (status: ${unit.status}).`);
    }

    const lastBlock = await tx.unitStatusHistory.findFirst({
      where: { unitId: unit.id, toStatus: "BLOCKED" },
      orderBy: { createdAt: "desc" },
      select: { fromStatus: true },
    });
    const prior = lastBlock?.fromStatus;
    if (!prior) {
      throw new UnitBlockError(
        "No prior status recorded for this unit; cannot determine what to unblock to.",
      );
    }

    const restoredTo: UnitStatus = prior === "HELD" ? "AVAILABLE" : prior;
    if (!isRestorable(restoredTo)) {
      throw new InvalidTransitionError("BLOCKED", restoredTo);
    }

    await tx.unit.update({
      where: { id: unit.id },
      data: { status: restoredTo, blockReason: null, blockedById: null, blockedAt: null },
    });
    await tx.unitStatusHistory.create({
      data: {
        unitId: unit.id,
        fromStatus: "BLOCKED",
        toStatus: restoredTo,
        reason: params.reason ?? "unblocked",
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Unit",
      entityId: unit.id,
      before: { status: "BLOCKED" },
      after: { status: restoredTo },
      reason: params.reason,
    });

    return { restoredTo };
  });
}

function isRestorable(status: UnitStatus): boolean {
  return status !== "BLOCKED";
}

// ── Delta read for the live board ──────────────────────────────────────

export interface UnitDelta {
  id: string;
  unitNumber: string;
  floor: number;
  status: UnitStatus;
  currentHoldExpiresAt: Date | null;
  updatedAt: Date;
}

/** Returns only units changed since `since`, for the board's polling refresh
 *  (docs/21-TIER-LIMITS.md section 1 -- 60s on the free tier). Status is the
 *  EFFECTIVE status: a hold that has expired but not yet been swept reads as
 *  AVAILABLE, so the board is never wrong between sweeps. */
export async function getUnitDeltas(
  db: PrismaClient,
  params: { projectId: string; since?: Date; now?: Date },
): Promise<{ units: UnitDelta[]; serverTime: Date }> {
  const now = params.now ?? new Date();
  const rows = await db.unit.findMany({
    where: {
      projectId: params.projectId,
      ...(params.since ? { updatedAt: { gt: params.since } } : {}),
    },
    select: {
      id: true,
      unitNumber: true,
      floor: true,
      status: true,
      updatedAt: true,
      currentHoldId: true,
    },
    orderBy: { updatedAt: "asc" },
  });

  const holdIds = rows.map((r) => r.currentHoldId).filter((id): id is string => id !== null);
  const holds = holdIds.length
    ? await db.unitHold.findMany({
        where: { id: { in: holdIds } },
        select: { id: true, expiresAt: true, releasedAt: true },
      })
    : [];
  const holdById = new Map(holds.map((h) => [h.id, h]));

  const units = rows.map((r) => {
    const hold = r.currentHoldId ? (holdById.get(r.currentHoldId) ?? null) : null;
    const status = effectiveUnitStatus({ status: r.status }, hold, now);
    return {
      id: r.id,
      unitNumber: r.unitNumber,
      floor: r.floor,
      status,
      currentHoldExpiresAt: status === "HELD" && hold ? hold.expiresAt : null,
      updatedAt: r.updatedAt,
    };
  });

  return { units, serverTime: now };
}
