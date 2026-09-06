// Unit holds -- the concurrency-critical core of Phase 1
// (docs/06-INVENTORY-SPEC.md section 2). Two associates tapping "Hold" on the
// same unit in the same second is the realistic failure mode, and a
// double-hold corrupts inventory silently: nobody notices until two
// customers have paid for the same flat.
//
// Two independent defences, both required:
//   1. Transactional: SELECT ... FOR UPDATE on the unit row serialises
//      check-then-act. The loser blocks until the winner commits, then sees
//      status = HELD and gets a clean, named rejection.
//   2. Structural: the partial unique index one_active_hold_per_unit
//      (hand-written migration, gate-tested in packages/db) makes the database
//      refuse a second live hold even if a future code path forgets the lock.
//      A P2002 from that index is caught and converted to the same rejection.
import { Prisma } from "@desire/db";
import type { PrismaClient, UnitStatus } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertValidTransition } from "./unit-transitions";

// ── Errors ─────────────────────────────────────────────────────────────

export class UnitNotFoundError extends Error {
  constructor(unitId: string) {
    super(`Unit ${unitId} not found.`);
    this.name = "UnitNotFoundError";
  }
}

/** The lost-race error. Carries who won so the UI can say
 *  "Just taken by Ravi (A-0042)" -- never a generic failure
 *  (docs/08-SCREENS.md). */
export class UnitNotAvailableError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly status: UnitStatus,
    public readonly heldBy?: { associateId: string; code: string; name: string },
  ) {
    super(
      heldBy
        ? `Unit is held by ${heldBy.name} (${heldBy.code}).`
        : `Unit is not available (status: ${status}).`,
    );
    this.name = "UnitNotAvailableError";
  }
}

export class HoldQuotaExceededError extends Error {
  constructor(
    public readonly associateId: string,
    public readonly quota: number,
    public readonly liveHolds: number,
  ) {
    super(`Hold quota exceeded: ${liveHolds} live hold(s) of ${quota} allowed.`);
    this.name = "HoldQuotaExceededError";
  }
}

export class HoldGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldGuardError";
  }
}

export class HoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`Hold ${holdId} not found or already released.`);
    this.name = "HoldNotFoundError";
  }
}

export class HoldExtensionLimitError extends Error {
  constructor(public readonly max: number) {
    super(`Hold has already been extended the maximum ${max} time(s).`);
    this.name = "HoldExtensionLimitError";
  }
}

// ── Lazy expiry ────────────────────────────────────────────────────────
//
// Correctness never depends on the sweep job running (docs/06-INVENTORY-SPEC.md
// section 3, docs/21-TIER-LIMITS.md section 11). Any read treats a hold past
// its expiresAt as gone. The sweep only materialises the release row, the
// history entry, and the notification.

export function isHoldLive(hold: { expiresAt: Date; releasedAt: Date | null }, now: Date = new Date()): boolean {
  return hold.releasedAt === null && hold.expiresAt > now;
}

/** What a reader should treat the unit's status as, accounting for a hold that
 *  has expired but not yet been swept. */
export function effectiveUnitStatus(
  unit: { status: UnitStatus },
  currentHold: { expiresAt: Date; releasedAt: Date | null } | null,
  now: Date = new Date(),
): UnitStatus {
  if (unit.status === "HELD" && (!currentHold || !isHoldLive(currentHold, now))) {
    return "AVAILABLE";
  }
  return unit.status;
}

// ── Acquire (the GATE) ─────────────────────────────────────────────────

export interface AcquireHoldParams {
  orgId: string;
  unitId: string;
  associateId: string;
  leadId?: string;
  audit: AuditContext;
  now?: Date;
}

export interface AcquiredHold {
  holdId: string;
  unitId: string;
  expiresAt: Date;
}

type LockedUnitRow = {
  id: string;
  status: UnitStatus;
  projectId: string;
  currentHoldId: string | null;
};

export async function acquireHold(db: PrismaClient, params: AcquireHoldParams): Promise<AcquiredHold> {
  const now = params.now ?? new Date();

  try {
    return await db.$transaction(
      async (tx) => {
        // 1. Row-lock the unit. Every concurrent attempt queues here.
        const locked = await tx.$queryRaw<LockedUnitRow[]>`
          SELECT "id", "status", "projectId", "currentHoldId"
          FROM "units" WHERE "id" = ${params.unitId} FOR UPDATE
        `;
        const unit = locked[0];
        if (!unit) throw new UnitNotFoundError(params.unitId);

        // 2. Lazy expiry: a HELD unit whose hold has silently expired is
        //    available. Materialise the release here, inside the same lock,
        //    so the sweep and a concurrent acquirer can't disagree.
        let status = unit.status;
        if (status === "HELD" && unit.currentHoldId) {
          const hold = await tx.unitHold.findUnique({ where: { id: unit.currentHoldId } });
          if (!hold || !isHoldLive(hold, now)) {
            if (hold && hold.releasedAt === null) {
              await tx.unitHold.update({
                where: { id: hold.id },
                data: { releasedAt: now, releaseReason: "EXPIRED" },
              });
            }
            await tx.unit.update({
              where: { id: unit.id },
              data: { status: "AVAILABLE", currentHoldId: null },
            });
            await tx.unitStatusHistory.create({
              data: {
                unitId: unit.id,
                fromStatus: "HELD",
                toStatus: "AVAILABLE",
                reason: "hold expired (lazy, on acquire)",
                actorId: null,
                actorLabel: "system",
              },
            });
            status = "AVAILABLE";
          }
        }

        // 3. Structural + business guards.
        if (status !== "AVAILABLE") {
          const heldBy = await currentHolder(tx, unit.currentHoldId);
          throw new UnitNotAvailableError(unit.id, status, heldBy);
        }
        assertValidTransition("AVAILABLE", "HELD");

        const project = await tx.project.findUniqueOrThrow({
          where: { id: unit.projectId },
          select: { holdTtlMinutes: true, reraValidTill: true, reraRegNo: true },
        });
        if (!project.reraRegNo || !project.reraValidTill || project.reraValidTill < now) {
          throw new HoldGuardError("Project RERA registration is missing or expired; units cannot be held.");
        }

        const activePriceList = await tx.priceList.findFirst({
          where: {
            projectId: unit.projectId,
            status: "ACTIVE",
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gt: now } }],
          },
          select: { id: true },
        });
        if (!activePriceList) {
          throw new HoldGuardError("No active price list for this project; units cannot be held.");
        }

        await assertQuotaAvailable(tx, params.associateId, now);

        // 4. Create the hold + flip the unit. The partial unique index is the
        //    backstop if anything above was ever bypassed.
        const expiresAt = new Date(now.getTime() + project.holdTtlMinutes * 60_000);
        const hold = await tx.unitHold.create({
          data: {
            orgId: params.orgId,
            unitId: unit.id,
            associateId: params.associateId,
            leadId: params.leadId,
            expiresAt,
          },
        });
        await tx.unit.update({
          where: { id: unit.id },
          data: { status: "HELD", currentHoldId: hold.id },
        });
        await tx.unitStatusHistory.create({
          data: {
            unitId: unit.id,
            fromStatus: "AVAILABLE",
            toStatus: "HELD",
            reason: "hold acquired",
            actorId: params.audit.actorId,
            actorLabel: params.audit.actorLabel,
          },
        });
        await writeAuditLog(tx, params.audit, {
          action: "CREATE",
          entity: "UnitHold",
          entityId: hold.id,
          after: { unitId: unit.id, associateId: params.associateId, expiresAt },
        });

        return { holdId: hold.id, unitId: unit.id, expiresAt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    // P2002 on unit_holds = the partial unique index fired. Only reachable if
    // the row lock was somehow bypassed -- still surface it as a clean, named
    // loss rather than a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const heldBy = await currentHolderByUnit(db, params.unitId);
      throw new UnitNotAvailableError(params.unitId, "HELD", heldBy);
    }
    throw err;
  }
}

async function assertQuotaAvailable(
  tx: Prisma.TransactionClient,
  associateId: string,
  now: Date,
): Promise<void> {
  const grade = await tx.associateGrade.findFirst({
    where: { associateId, validTo: null },
    include: { grade: { select: { holdQuota: true } } },
  });
  // No grade assignment = no quota. Safer than defaulting to "some".
  const quota = grade?.grade.holdQuota ?? 0;

  const liveHolds = await tx.unitHold.count({
    where: { associateId, releasedAt: null, expiresAt: { gt: now } },
  });
  if (liveHolds >= quota) {
    throw new HoldQuotaExceededError(associateId, quota, liveHolds);
  }
}

async function currentHolder(tx: Prisma.TransactionClient, holdId: string | null) {
  if (!holdId) return undefined;
  const hold = await tx.unitHold.findUnique({
    where: { id: holdId },
    include: { associate: { include: { user: { select: { name: true } } } } },
  });
  if (!hold) return undefined;
  return { associateId: hold.associateId, code: hold.associate.code, name: hold.associate.user.name };
}

async function currentHolderByUnit(db: PrismaClient, unitId: string) {
  const hold = await db.unitHold.findFirst({
    where: { unitId, releasedAt: null },
    include: { associate: { include: { user: { select: { name: true } } } } },
  });
  if (!hold) return undefined;
  return { associateId: hold.associateId, code: hold.associate.code, name: hold.associate.user.name };
}

// ── Release ────────────────────────────────────────────────────────────

export type ManualReleaseReason = "RELEASED_BY_ASSOCIATE" | "RELEASED_BY_ADMIN";

export async function releaseHold(
  db: PrismaClient,
  params: { holdId: string; reason: ManualReleaseReason; note?: string; audit: AuditContext; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date();
  if (params.reason === "RELEASED_BY_ADMIN" && !params.note) {
    throw new HoldGuardError("Admin force-release requires a reason note.");
  }

  await db.$transaction(async (tx) => {
    const hold = await tx.unitHold.findFirst({ where: { id: params.holdId, releasedAt: null } });
    if (!hold) throw new HoldNotFoundError(params.holdId);

    // Lock the unit so a concurrent acquire can't interleave with the flip.
    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${hold.unitId} FOR UPDATE`;

    await tx.unitHold.update({
      where: { id: hold.id },
      data: { releasedAt: now, releaseReason: params.reason, releasedById: params.audit.actorId },
    });
    await tx.unit.update({
      where: { id: hold.unitId },
      data: { status: "AVAILABLE", currentHoldId: null },
    });
    await tx.unitStatusHistory.create({
      data: {
        unitId: hold.unitId,
        fromStatus: "HELD",
        toStatus: "AVAILABLE",
        reason: params.note ?? params.reason,
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "UnitHold",
      entityId: hold.id,
      before: { releasedAt: null },
      after: { releasedAt: now, releaseReason: params.reason },
      reason: params.note,
    });
  });
}

// ── Extend ─────────────────────────────────────────────────────────────

export async function extendHold(
  db: PrismaClient,
  params: { holdId: string; audit: AuditContext; now?: Date },
): Promise<{ expiresAt: Date }> {
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    const hold = await tx.unitHold.findFirst({
      where: { id: params.holdId, releasedAt: null },
      include: { unit: { select: { projectId: true } } },
    });
    if (!hold || !isHoldLive(hold, now)) throw new HoldNotFoundError(params.holdId);

    const project = await tx.project.findUniqueOrThrow({
      where: { id: hold.unit.projectId },
      select: { holdExtensionMinutes: true, maxHoldExtensions: true },
    });
    if (hold.extensionCount >= project.maxHoldExtensions) {
      throw new HoldExtensionLimitError(project.maxHoldExtensions);
    }

    const expiresAt = new Date(hold.expiresAt.getTime() + project.holdExtensionMinutes * 60_000);
    await tx.unitHold.update({
      where: { id: hold.id },
      data: { expiresAt, extensionCount: { increment: 1 } },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "UnitHold",
      entityId: hold.id,
      before: { expiresAt: hold.expiresAt, extensionCount: hold.extensionCount },
      after: { expiresAt, extensionCount: hold.extensionCount + 1 },
    });
    return { expiresAt };
  });
}

// ── Expiry sweep ───────────────────────────────────────────────────────
//
// Run by external cron every 5 minutes (docs/21-TIER-LIMITS.md section 11).
// Idempotent: a delayed or duplicated run finds nothing left to do. Returns
// what it released so the job endpoint can report it and fire notifications.

export async function expireStaleHolds(
  db: PrismaClient,
  params: { now?: Date; limit?: number } = {},
): Promise<{ released: Array<{ holdId: string; unitId: string; associateId: string }> }> {
  const now = params.now ?? new Date();
  const stale = await db.unitHold.findMany({
    where: { releasedAt: null, expiresAt: { lte: now } },
    select: { id: true, unitId: true, associateId: true },
    take: params.limit ?? 500,
  });

  const released: Array<{ holdId: string; unitId: string; associateId: string }> = [];
  for (const hold of stale) {
    // One transaction per hold: a failure on one must not roll back the rest,
    // and each takes the unit row lock so it can't race an acquire.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${hold.unitId} FOR UPDATE`;
      const fresh = await tx.unitHold.findFirst({ where: { id: hold.id, releasedAt: null } });
      if (!fresh) return; // lazily released by an acquire in the meantime -- nothing to do
      await tx.unitHold.update({
        where: { id: hold.id },
        data: { releasedAt: now, releaseReason: "EXPIRED" },
      });
      await tx.unit.updateMany({
        where: { id: hold.unitId, currentHoldId: hold.id },
        data: { status: "AVAILABLE", currentHoldId: null },
      });
      await tx.unitStatusHistory.create({
        data: {
          unitId: hold.unitId,
          fromStatus: "HELD",
          toStatus: "AVAILABLE",
          reason: "hold expired (sweep)",
          actorId: null,
          actorLabel: "system:hold-expiry-sweep",
        },
      });
      released.push({ holdId: hold.id, unitId: hold.unitId, associateId: hold.associateId });
    });
  }
  return { released };
}
