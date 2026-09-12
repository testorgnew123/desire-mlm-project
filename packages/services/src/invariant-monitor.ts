// The Invariant Monitor GATE -- Phase 3 Slice 7 (PROGRESS.md, docs/16-ROADMAP.md:
// "the invariant monitor ships in Phase 3, with the engine -- not after").
// docs/13-TEST-STRATEGY.md's full invariant list, across all four domains
// (Commission, Inventory, Collections, Network & duties) -- the SAME
// assertions already proven at the unit/integration level throughout this
// project, re-checked live against real data. Never throws; always reports.
import type { Prisma, PrismaClient } from "@desire/db";

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

export interface InvariantCheckResult {
  ok: boolean;
  violations: InvariantViolation[];
}

interface Check {
  name: string;
  run: (db: PrismaClient) => Promise<InvariantViolation[]>;
}

// ── Commission (6) ───────────────────────────────────────────────────────

const commissionChecks: Check[] = [
  {
    name: "commission.max_total_pct",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ bookingId: string; schemeId: string; total: Prisma.Decimal; ceiling: Prisma.Decimal }>>`
        SELECT ce."bookingId", ce."schemeId", SUM(ce."grossAmount") AS total,
               (b."commissionableValue" * cs."maxTotalPct" / 100) AS ceiling
        FROM commission_entries ce
        JOIN bookings b ON b.id = ce."bookingId"
        JOIN commission_schemes cs ON cs.id = ce."schemeId"
        GROUP BY ce."bookingId", ce."schemeId", b."commissionableValue", cs."maxTotalPct"
        HAVING SUM(ce."grossAmount") > (b."commissionableValue" * cs."maxTotalPct" / 100)
      `;
      return rows.map((r) => ({
        invariant: "commission.max_total_pct",
        detail: `Booking ${r.bookingId} scheme ${r.schemeId}: entries total ${r.total.toString()} exceeds ceiling ${r.ceiling.toString()}.`,
      }));
    },
  },
  {
    name: "commission.releases_not_exceed_gross",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ entryId: string; released: Prisma.Decimal; grossAmount: Prisma.Decimal }>>`
        SELECT cr."entryId", SUM(cr.amount) AS released, ce."grossAmount"
        FROM commission_releases cr
        JOIN commission_entries ce ON ce.id = cr."entryId"
        WHERE cr."reversedAt" IS NULL
        GROUP BY cr."entryId", ce."grossAmount"
        HAVING SUM(cr.amount) > ce."grossAmount"
      `;
      return rows.map((r) => ({
        invariant: "commission.releases_not_exceed_gross",
        detail: `Entry ${r.entryId}: released ${r.released.toString()} exceeds grossAmount ${r.grossAmount.toString()}.`,
      }));
    },
  },
  {
    // Every CommissionEntry row must trace back to the audited path that
    // created it -- the append-only ledger's own rule ("Never UPDATE
    // gross_amount. Never DELETE.") has no other mechanism in this schema to
    // verify against, since entries carry no updatedAt/version column.
    name: "commission.entries_are_audited",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT ce.id FROM commission_entries ce
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_logs al
          WHERE al.entity = 'CommissionEntry' AND al."entityId" = ce.id AND al.action = 'CREATE'
        )
      `;
      return rows.map((r) => ({
        invariant: "commission.entries_are_audited",
        detail: `Entry ${r.id} has no CREATE audit log row.`,
      }));
    },
  },
  {
    name: "commission.snapshot_has_scheme_version",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM commission_entries
        WHERE snapshot IS NULL OR snapshot = '{}'::jsonb OR NOT (snapshot ? 'schemeVersion')
      `;
      return rows.map((r) => ({
        invariant: "commission.snapshot_has_scheme_version",
        detail: `Entry ${r.id} has an empty snapshot or is missing schemeVersion.`,
      }));
    },
  },
  {
    name: "commission.contra_source_resolvable",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string; sourceEntryId: string }>>`
        SELECT ce.id, ce."sourceEntryId" FROM commission_entries ce
        LEFT JOIN commission_entries src ON src.id = ce."sourceEntryId"
        WHERE ce."sourceEntryId" IS NOT NULL AND src.id IS NULL
      `;
      return rows.map((r) => ({
        invariant: "commission.contra_source_resolvable",
        detail: `Contra entry ${r.id} points at sourceEntryId ${r.sourceEntryId}, which does not exist.`,
      }));
    },
  },
  {
    name: "commission.one_self_entry_per_booking_scheme",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ bookingId: string; schemeId: string; count: bigint }>>`
        SELECT "bookingId", "schemeId", COUNT(*) AS count FROM commission_entries
        WHERE role = 'SELF'
        GROUP BY "bookingId", "schemeId"
        HAVING COUNT(*) > 1
      `;
      return rows.map((r) => ({
        invariant: "commission.one_self_entry_per_booking_scheme",
        detail: `Booking ${r.bookingId} scheme ${r.schemeId} has ${r.count} SELF entries, expected at most 1.`,
      }));
    },
  },
];

// ── Inventory (3) ────────────────────────────────────────────────────────

const inventoryChecks: Check[] = [
  {
    name: "inventory.one_live_hold_per_unit",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ unitId: string; count: bigint }>>`
        SELECT "unitId", COUNT(*) AS count FROM unit_holds
        WHERE "releasedAt" IS NULL
        GROUP BY "unitId"
        HAVING COUNT(*) > 1
      `;
      return rows.map((r) => ({
        invariant: "inventory.one_live_hold_per_unit",
        detail: `Unit ${r.unitId} has ${r.count} live holds, expected at most 1.`,
      }));
    },
  },
  {
    name: "inventory.booked_unit_has_one_confirmed_booking",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string; count: bigint }>>`
        SELECT u.id, (SELECT COUNT(*) FROM bookings b WHERE b."unitId" = u.id AND b.status = 'CONFIRMED') AS count
        FROM units u
        WHERE u.status = 'BOOKED'
          AND (SELECT COUNT(*) FROM bookings b WHERE b."unitId" = u.id AND b.status = 'CONFIRMED') <> 1
      `;
      return rows.map((r) => ({
        invariant: "inventory.booked_unit_has_one_confirmed_booking",
        detail: `Unit ${r.id} is BOOKED but has ${r.count} CONFIRMED bookings, expected exactly 1.`,
      }));
    },
  },
  {
    name: "inventory.live_holds_within_grade_quota",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ associateId: string; liveHolds: bigint; holdQuota: number }>>`
        SELECT uh."associateId", COUNT(*) AS "liveHolds", g."holdQuota"
        FROM unit_holds uh
        JOIN associate_grades ag ON ag."associateId" = uh."associateId" AND ag."validTo" IS NULL
        JOIN grades g ON g.id = ag."gradeId"
        WHERE uh."releasedAt" IS NULL
        GROUP BY uh."associateId", g."holdQuota"
        HAVING COUNT(*) > g."holdQuota"
      `;
      return rows.map((r) => ({
        invariant: "inventory.live_holds_within_grade_quota",
        detail: `Associate ${r.associateId} has ${r.liveHolds} live holds, exceeding their grade's quota of ${r.holdQuota}.`,
      }));
    },
  },
];

// ── Collections (4) ──────────────────────────────────────────────────────

const collectionsChecks: Check[] = [
  {
    name: "collections.allocations_not_exceed_receipt",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ receiptId: string; allocated: Prisma.Decimal; amount: Prisma.Decimal }>>`
        SELECT ra."receiptId", SUM(ra.amount) AS allocated, r.amount
        FROM receipt_allocations ra
        JOIN receipts r ON r.id = ra."receiptId"
        WHERE ra."reversedAt" IS NULL
        GROUP BY ra."receiptId", r.amount
        HAVING SUM(ra.amount) > r.amount
      `;
      return rows.map((r) => ({
        invariant: "collections.allocations_not_exceed_receipt",
        detail: `Receipt ${r.receiptId}: allocated ${r.allocated.toString()} exceeds its own amount ${r.amount.toString()}.`,
      }));
    },
  },
  {
    name: "collections.allocations_not_exceed_demand",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ demandId: string; allocated: Prisma.Decimal; owed: Prisma.Decimal }>>`
        SELECT ra."demandId", SUM(ra.amount) AS allocated, (d.amount + d."gstAmount") AS owed
        FROM receipt_allocations ra
        JOIN demands d ON d.id = ra."demandId"
        WHERE ra."reversedAt" IS NULL
        GROUP BY ra."demandId", d.amount, d."gstAmount"
        HAVING SUM(ra.amount) > (d.amount + d."gstAmount")
      `;
      return rows.map((r) => ({
        invariant: "collections.allocations_not_exceed_demand",
        detail: `Demand ${r.demandId}: allocated ${r.allocated.toString()} exceeds amount+GST ${r.owed.toString()}.`,
      }));
    },
  },
  {
    name: "collections.cleared_reconciles_to_allocated_plus_credit",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ bookingId: string; cleared: Prisma.Decimal; allocated: Prisma.Decimal; creditBalance: Prisma.Decimal }>>`
        SELECT b.id AS "bookingId",
               COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r."bookingId" = b.id AND r.status = 'CLEARED'), 0) AS cleared,
               COALESCE((SELECT SUM(ra.amount) FROM receipt_allocations ra JOIN receipts r2 ON r2.id = ra."receiptId" WHERE r2."bookingId" = b.id AND ra."reversedAt" IS NULL), 0) AS allocated,
               b."creditBalance"
        FROM bookings b
        WHERE COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r."bookingId" = b.id AND r.status = 'CLEARED'), 0)
              <> COALESCE((SELECT SUM(ra.amount) FROM receipt_allocations ra JOIN receipts r2 ON r2.id = ra."receiptId" WHERE r2."bookingId" = b.id AND ra."reversedAt" IS NULL), 0) + b."creditBalance"
      `;
      return rows.map((r) => ({
        invariant: "collections.cleared_reconciles_to_allocated_plus_credit",
        detail: `Booking ${r.bookingId}: cleared ${r.cleared.toString()} != allocated ${r.allocated.toString()} + creditBalance ${r.creditBalance.toString()}.`,
      }));
    },
  },
  {
    // Structurally enforced by @@unique([demandId, rung]) already -- kept as
    // a real, re-checked assertion rather than assumed from the schema.
    name: "collections.at_most_one_alert_per_demand_rung",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ demandId: string; rung: string; count: bigint }>>`
        SELECT "demandId", rung, COUNT(*) AS count FROM collection_alerts
        GROUP BY "demandId", rung
        HAVING COUNT(*) > 1
      `;
      return rows.map((r) => ({
        invariant: "collections.at_most_one_alert_per_demand_rung",
        detail: `Demand ${r.demandId} rung ${r.rung} has ${r.count} alerts, expected at most 1.`,
      }));
    },
  },
];

// ── Network & duties (3) ─────────────────────────────────────────────────

const networkChecks: Check[] = [
  {
    name: "network.one_live_hierarchy_row_per_associate",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ associateId: string; count: bigint }>>`
        SELECT "associateId", COUNT(*) AS count FROM associate_hierarchy
        WHERE "validTo" IS NULL
        GROUP BY "associateId"
        HAVING COUNT(*) <> 1
      `;
      return rows.map((r) => ({
        invariant: "network.one_live_hierarchy_row_per_associate",
        detail: `Associate ${r.associateId} has ${r.count} live hierarchy rows, expected exactly 1.`,
      }));
    },
  },
  {
    name: "network.not_own_ancestor",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string; associateId: string }>>`
        SELECT id, "associateId" FROM associate_hierarchy
        WHERE "validTo" IS NULL AND path LIKE '%/' || "associateId" || '/%'
      `;
      return rows.map((r) => ({
        invariant: "network.not_own_ancestor",
        detail: `Associate ${r.associateId}'s current hierarchy row (${r.id}) names them as their own ancestor.`,
      }));
    },
  },
  {
    name: "network.receipt_verification_separation_of_duties",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string; reason: string }>>`
        SELECT r.id,
          CASE
            WHEN r."enteredById" = r."verifiedById" THEN 'entered and verified by the same person'
            WHEN sellerUser."id" IS NOT NULL THEN 'verified by the booking''s own selling associate'
            WHEN uplineUser."id" IS NOT NULL THEN 'verified by an upline of the selling associate'
          END AS reason
        FROM receipts r
        JOIN bookings b ON b.id = r."bookingId"
        LEFT JOIN associates sellerAssoc ON sellerAssoc.id = b."sellingAssociateId"
        LEFT JOIN users sellerUser ON sellerUser.id = r."verifiedById" AND sellerUser.id = sellerAssoc."userId"
        LEFT JOIN associate_hierarchy sellerHierarchy ON sellerHierarchy."associateId" = b."sellingAssociateId" AND sellerHierarchy."validTo" IS NULL
        LEFT JOIN associates uplineAssoc ON uplineAssoc."userId" = r."verifiedById" AND sellerHierarchy.path LIKE '%/' || uplineAssoc.id || '/%'
        LEFT JOIN users uplineUser ON uplineUser.id = uplineAssoc."userId"
        WHERE r."verifiedById" IS NOT NULL
          AND (r."enteredById" = r."verifiedById" OR sellerUser."id" IS NOT NULL OR uplineUser."id" IS NOT NULL)
      `;
      return rows.map((r) => ({
        invariant: "network.receipt_verification_separation_of_duties",
        detail: `Receipt ${r.id}: ${r.reason}.`,
      }));
    },
  },
  {
    name: "network.payout_batch_maker_checker",
    async run(db) {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM payout_batches WHERE "approvedById" IS NOT NULL AND "approvedById" = "preparedById"
      `;
      return rows.map((r) => ({
        invariant: "network.payout_batch_maker_checker",
        detail: `Payout batch ${r.id} was approved by its own preparer.`,
      }));
    },
  },
];

const ALL_CHECKS: Check[] = [...commissionChecks, ...inventoryChecks, ...collectionsChecks, ...networkChecks];

/** Runs every invariant in docs/13-TEST-STRATEGY.md's list against real
 *  data. Never throws -- a check that itself errors is reported as a
 *  violation (the monitor's own failure must not look like a clean pass),
 *  and every OTHER check still runs. */
export async function runInvariantChecks(db: PrismaClient): Promise<InvariantCheckResult> {
  const violations: InvariantViolation[] = [];

  for (const check of ALL_CHECKS) {
    try {
      violations.push(...(await check.run(db)));
    } catch (err) {
      violations.push({
        invariant: check.name,
        detail: `Check itself failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
