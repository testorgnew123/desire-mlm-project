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

// ── Back-office reads (Phase 3.5 Slice 8) ───────────────────────────────
//
// No permission check inside these two -- same convention getUnitDeltas
// above already established in this file: the caller (an RSC page)
// asserts unit.read itself, the same way board/[projectId]/page.tsx does.

export interface ActiveHoldRow {
  holdId: string;
  unitId: string;
  unitNumber: string;
  projectId: string;
  projectName: string;
  expiresAt: Date;
  associateId: string;
  associateName: string;
  associateCode: string;
}

/** Every currently-live hold org-wide (or scoped to one project) -- the
 *  delta-since endpoint the board polls cannot answer "list them all",
 *  only "what changed"; this is the narrow full-list read Slice 8 needs. */
export async function listActiveHolds(
  db: PrismaClient,
  params: { orgId: string; projectId?: string; now?: Date },
): Promise<ActiveHoldRow[]> {
  const now = params.now ?? new Date();
  const holds = await db.unitHold.findMany({
    where: {
      orgId: params.orgId,
      releasedAt: null,
      expiresAt: { gt: now },
      ...(params.projectId ? { unit: { projectId: params.projectId } } : {}),
    },
    select: {
      id: true,
      expiresAt: true,
      unit: { select: { id: true, unitNumber: true, projectId: true, project: { select: { name: true } } } },
      associate: { select: { id: true, code: true, user: { select: { name: true } } } },
    },
    orderBy: { expiresAt: "asc" },
  });

  return holds.map((hold) => ({
    holdId: hold.id,
    unitId: hold.unit.id,
    unitNumber: hold.unit.unitNumber,
    projectId: hold.unit.projectId,
    projectName: hold.unit.project.name,
    expiresAt: hold.expiresAt,
    associateId: hold.associate.id,
    associateName: hold.associate.user.name,
    associateCode: hold.associate.code,
  }));
}

export interface BlockedUnitRow {
  unitId: string;
  unitNumber: string;
  projectId: string;
  projectName: string;
  blockReason: string | null;
  blockedAt: Date | null;
  blockedByLabel: string | null;
}

/** Every unit currently BLOCKED org-wide (or scoped to one project). */
export async function listBlockedUnits(
  db: PrismaClient,
  params: { orgId: string; projectId?: string },
): Promise<BlockedUnitRow[]> {
  const units = await db.unit.findMany({
    where: {
      orgId: params.orgId,
      status: "BLOCKED",
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
    select: {
      id: true,
      unitNumber: true,
      projectId: true,
      project: { select: { name: true } },
      blockReason: true,
      blockedAt: true,
      blockedById: true,
    },
    orderBy: { blockedAt: "desc" },
  });

  const blockerIds = units.map((unit) => unit.blockedById).filter((id): id is string => id !== null);
  const blockers = blockerIds.length
    ? await db.user.findMany({ where: { id: { in: blockerIds } }, select: { id: true, name: true } })
    : [];
  const blockerNameById = new Map(blockers.map((user) => [user.id, user.name]));

  return units.map((unit) => ({
    unitId: unit.id,
    unitNumber: unit.unitNumber,
    projectId: unit.projectId,
    projectName: unit.project.name,
    blockReason: unit.blockReason,
    blockedAt: unit.blockedAt,
    blockedByLabel: unit.blockedById ? (blockerNameById.get(unit.blockedById) ?? null) : null,
  }));
}

export interface StockStatementRow {
  towerName: string | null;
  unitTypeName: string;
  status: UnitStatus;
  count: number;
}

/** Units grouped by tower/unit-type/EFFECTIVE status for one project -- the
 *  "Stock statement" screen. No existing aggregation covers this shape
 *  (getUnitDeltas is a flat per-unit list; board's own page.tsx loads the
 *  full catalogue for display, not a grouped count).
 *
 *  Deliberately fetch-then-reduce in JS, not a SQL-side groupBy on the raw
 *  `status` column: a hold past its expiresAt reads as AVAILABLE everywhere
 *  else in this codebase (effectiveUnitStatus) even before the sweep
 *  materialises the release, and a statement grouping on the raw column
 *  would disagree with the board and the holds screen for as long as an
 *  expired hold sits unswept -- confirmed live during Slice 8's own
 *  verification. A project's unit count is bounded (hundreds, per board's
 *  own precedent of loading the full catalogue), so this is cheap. */
export async function getStockStatement(
  db: PrismaClient,
  params: { orgId: string; projectId: string; now?: Date },
): Promise<StockStatementRow[]> {
  const now = params.now ?? new Date();

  const units = await db.unit.findMany({
    where: { orgId: params.orgId, projectId: params.projectId },
    select: { towerId: true, unitTypeId: true, status: true, currentHoldId: true },
  });

  const holdIds = units.map((unit) => unit.currentHoldId).filter((id): id is string => id !== null);
  const holds = holdIds.length
    ? await db.unitHold.findMany({ where: { id: { in: holdIds } }, select: { id: true, expiresAt: true, releasedAt: true } })
    : [];
  const holdById = new Map(holds.map((hold) => [hold.id, hold]));

  const [towers, unitTypes] = await Promise.all([
    db.tower.findMany({ where: { projectId: params.projectId }, select: { id: true, name: true } }),
    db.unitType.findMany({ where: { projectId: params.projectId }, select: { id: true, name: true } }),
  ]);
  const towerNameById = new Map(towers.map((tower) => [tower.id, tower.name]));
  const unitTypeNameById = new Map(unitTypes.map((unitType) => [unitType.id, unitType.name]));

  const counts = new Map<string, StockStatementRow>();
  for (const unit of units) {
    const hold = unit.currentHoldId ? (holdById.get(unit.currentHoldId) ?? null) : null;
    const status = effectiveUnitStatus({ status: unit.status }, hold, now);
    const towerName = unit.towerId ? (towerNameById.get(unit.towerId) ?? null) : null;
    const unitTypeName = unitTypeNameById.get(unit.unitTypeId) ?? unit.unitTypeId;
    const key = `${towerName ?? ""} ${unitTypeName} ${status}`;

    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { towerName, unitTypeName, status, count: 1 });
    }
  }

  return [...counts.values()].sort(
    (a, b) => (a.towerName ?? "").localeCompare(b.towerName ?? "") || a.unitTypeName.localeCompare(b.unitTypeName),
  );
}
