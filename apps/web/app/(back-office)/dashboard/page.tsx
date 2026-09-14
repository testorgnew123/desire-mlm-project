import type { Metadata } from "next";
import { getPrismaClient, Prisma } from "@desire/db";
import { isHoldLive } from "@desire/services/holds";
import { getCollectionsConsole } from "@desire/services/collections-sweep";
import { listReceipts } from "@desire/services/receipts";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Dashboard — Desire",
};

/** Roles with a full project-level stock + booking overview. */
const STOCK_OVERVIEW_ROLES = new Set(["SUPER_ADMIN", "SALES_HEAD", "PROJECT_MANAGER"]);

/** Role-branched landing (docs/08-SCREENS.md: "Dashboard -- Role-specific
 *  landing"), one widget set per role's own duties rather than a single
 *  either/or view -- ASSOCIATE/TEAM_LEAD never land here, they land on the
 *  PWA Home tab instead (apps/web/app/page.tsx). No backend gaps: every
 *  widget below reads an existing table or the existing
 *  getCollectionsConsole function, nothing new. */
export default async function DashboardPage() {
  const session = await requireSession();
  const db = getPrismaClient();
  const { orgId } = session.user;
  const actorId = session.user.id;

  const roleCodes = await getRoleCodes(db, actorId);
  const isSuperAdmin = roleCodes.has("SUPER_ADMIN");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Dashboard</h1>

      {[...roleCodes].some((code) => STOCK_OVERVIEW_ROLES.has(code)) ? (
        <StockAndBookingSummary db={db} orgId={orgId} />
      ) : null}

      {isSuperAdmin || roleCodes.has("SALES_HEAD") ? <ExecutiveMetrics db={db} orgId={orgId} /> : null}

      {isSuperAdmin || roleCodes.has("FINANCE_ADMIN") ? (
        <>
          <CollectionsAgingSummary db={db} orgId={orgId} actorId={actorId} />
          <CommissionOverview db={db} orgId={orgId} />
          <FinanceOpsSummary db={db} orgId={orgId} actorId={actorId} />
        </>
      ) : null}

      {isSuperAdmin || roleCodes.has("PROJECT_MANAGER") ? (
        <>
          <PendingPriceLists db={db} orgId={orgId} />
          <ActiveHolds db={db} orgId={orgId} />
        </>
      ) : null}

      {isSuperAdmin || roleCodes.has("SALES_HEAD") ? <PendingDiscountApprovals db={db} orgId={orgId} /> : null}

      {roleCodes.has("AUDITOR") ? <RecentAuditLog db={db} orgId={orgId} /> : null}

      {roleCodes.has("SALES_ADMIN") || roleCodes.has("AUDITOR") ? <OpenItemsSummary db={db} orgId={orgId} /> : null}
    </div>
  );
}

async function getRoleCodes(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<Set<string>> {
  const userRoles = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { code: true } } },
  });
  return new Set(userRoles.map((userRole) => userRole.role.code));
}

async function StockAndBookingSummary({
  db,
  orgId,
}: {
  db: ReturnType<typeof getPrismaClient>;
  orgId: string;
}) {
  const [projectCount, unitsByStatus, bookingsByStatus] = await Promise.all([
    db.project.count({ where: { orgId } }),
    db.unit.groupBy({ by: ["status"], where: { orgId }, _count: true }),
    db.booking.groupBy({ by: ["status"], where: { orgId }, _count: true }),
  ]);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>{projectCount}</CardTitle>
          <CardDescription>Active projects</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Units by status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {unitsByStatus.map((row) => (
            <div key={row.status} className="flex justify-between tabular-nums">
              <span className="text-muted-foreground">{row.status}</span>
              <span>{row._count}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bookings by status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {bookingsByStatus.length === 0 ? (
            <p className="text-muted-foreground">No bookings yet.</p>
          ) : (
            bookingsByStatus.map((row) => (
              <div key={row.status} className="flex justify-between tabular-nums">
                <span className="text-muted-foreground">{row.status}</span>
                <span>{row._count}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const AGING_BUCKETS = [
  { label: "0-30 days", min: 0, max: 30 },
  { label: "31-60 days", min: 31, max: 60 },
  { label: "61-90 days", min: 61, max: 90 },
  { label: "90+ days", min: 91, max: Infinity },
] as const;

async function CollectionsAgingSummary({
  db,
  orgId,
  actorId,
}: {
  db: ReturnType<typeof getPrismaClient>;
  orgId: string;
  actorId: string;
}) {
  const rows = await getCollectionsConsole(db, { orgId, actorId });

  const buckets = AGING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row) => row.daysOverdue >= bucket.min && row.daysOverdue <= bucket.max);
    const total = inBucket.reduce((sum, row) => sum.plus(row.outstanding), new Prisma.Decimal(0));
    return { ...bucket, count: inBucket.length, total };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collections aging</CardTitle>
        <CardDescription>{rows.length} open demand(s) across the organization</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4">
        {buckets.map((bucket) => (
          <div key={bucket.label} className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{bucket.label}</p>
            <p className="font-medium tabular-nums">{formatMoney(bucket.total)}</p>
            <p className="text-xs text-muted-foreground">{bucket.count} demand(s)</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

async function CommissionOverview({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const byStatus = await db.commissionEntry.groupBy({
    by: ["status"],
    where: { orgId, status: { not: "REVERSED" } },
    _sum: { grossAmount: true },
  });
  const totalByStatus = new Map(byStatus.map((row) => [row.status, row._sum.grossAmount ?? new Prisma.Decimal(0)]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commission overview</CardTitle>
        <CardDescription>Organization-wide, non-reversed entries</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3 text-sm">
        {(["ACCRUED", "PAYABLE", "PAID"] as const).map((status) => (
          <div key={status}>
            <p className="text-xs text-muted-foreground">{status}</p>
            <p className="font-medium tabular-nums">{formatMoney(totalByStatus.get(status) ?? "0")}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

async function PendingPriceLists({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const priceLists = await db.priceList.findMany({
    where: { orgId, status: "PENDING_APPROVAL" },
    select: { id: true, name: true, version: true, project: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Price lists pending approval</CardTitle>
        <CardDescription>{priceLists.length} awaiting sign-off</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {priceLists.length === 0 ? (
          <p className="text-muted-foreground">Nothing pending.</p>
        ) : (
          priceLists.map((priceList) => (
            <div key={priceList.id} className="flex justify-between">
              <span>
                {priceList.project.name} — {priceList.name}
              </span>
              <span className="text-muted-foreground">v{priceList.version}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

async function PendingDiscountApprovals({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const requests = await db.discountRequest.findMany({
    where: { status: "PENDING", approverRoleCode: "SALES_HEAD", booking: { orgId } },
    select: {
      id: true,
      amount: true,
      pctOfBase: true,
      booking: { select: { bookingNumber: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discount approvals pending you</CardTitle>
        <CardDescription>{requests.length} request(s)</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {requests.length === 0 ? (
          <p className="text-muted-foreground">Nothing pending.</p>
        ) : (
          requests.map((request) => (
            <div key={request.id} className="flex justify-between">
              <span>{request.booking.bookingNumber}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatMoney(request.amount)} ({request.pctOfBase.toString()}%)
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

async function RecentAuditLog({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const entries = await db.auditLog.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, actorLabel: true, action: true, entity: true, entityId: true, createdAt: true },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>
          Last {entries.length} audited change(s) — full browsing lands in a later slice
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border text-sm">
        {entries.length === 0 ? (
          <p className="text-muted-foreground">No activity yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0">
              <span>
                {entry.actorLabel} — {entry.action} {entry.entity} {entry.entityId.slice(-6)}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

const SOLD_UNIT_STATUSES = ["BOOKED", "AGREEMENT_SIGNED", "REGISTERED", "POSSESSION"] as const;

/** The two Executive tiles docs/20-REPORTS.md names that the existing
 *  StockAndBookingSummary/CollectionsAgingSummary/CommissionOverview tiles
 *  don't cover: absorption (units sold as a share of total stock) and
 *  commission cost % (commission as a share of revenue). Both all-time
 *  org-wide figures -- a trailing-period velocity number is the separate
 *  "Absorption & velocity" report (not built this pass), not a dashboard
 *  tile's job. */
async function ExecutiveMetrics({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const [totalUnits, soldUnits, revenueAgg, commissionAgg] = await Promise.all([
    db.unit.count({ where: { orgId } }),
    db.unit.count({ where: { orgId, status: { in: [...SOLD_UNIT_STATUSES] } } }),
    db.booking.aggregate({ where: { orgId, status: { not: "CANCELLED" } }, _sum: { agreementValue: true } }),
    db.commissionEntry.aggregate({ where: { orgId, status: { not: "REVERSED" } }, _sum: { grossAmount: true } }),
  ]);

  const absorptionPct = totalUnits > 0 ? ((soldUnits / totalUnits) * 100).toFixed(1) : "0.0";
  const revenue = revenueAgg._sum.agreementValue ?? new Prisma.Decimal(0);
  const commission = commissionAgg._sum.grossAmount ?? new Prisma.Decimal(0);
  const commissionCostPct = revenue.greaterThan(0) ? commission.div(revenue).mul(100).toFixed(1) : "0.0";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{absorptionPct}%</CardTitle>
          <CardDescription>
            Absorption — {soldUnits} of {totalUnits} units sold
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{commissionCostPct}%</CardTitle>
          <CardDescription>Commission cost — of total booked revenue</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

async function ActiveHolds({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const holds = await db.unitHold.findMany({
    where: { orgId, releasedAt: null },
    select: { expiresAt: true, releasedAt: true, unit: { select: { unitNumber: true } }, associate: { select: { code: true } } },
    orderBy: { expiresAt: "asc" },
    take: 10,
  });
  const live = holds.filter((hold) => isHoldLive(hold));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active holds</CardTitle>
        <CardDescription>{live.length} live hold(s), soonest expiry first</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {live.length === 0 ? (
          <p className="text-muted-foreground">No active holds.</p>
        ) : (
          live.map((hold, index) => (
            <div key={index} className="flex justify-between">
              <span>
                Unit {hold.unit.unitNumber} — {hold.associate.code}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(hold.expiresAt)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** The two Finance tiles docs/20-REPORTS.md names that aren't covered yet:
 *  the verification queue (reuses receipts.ts's own listReceipts at its
 *  ENTERED filter -- "a receipts list and the verification queue are the
 *  same view of the same data at two different status filters", per that
 *  function's own header) and payout batch status counts. */
async function FinanceOpsSummary({ db, orgId, actorId }: { db: ReturnType<typeof getPrismaClient>; orgId: string; actorId: string }) {
  const [pendingVerification, batchesByStatus] = await Promise.all([
    listReceipts(db, { orgId, actorId, status: "ENTERED" }),
    db.payoutBatch.groupBy({ by: ["status"], where: { orgId }, _count: true }),
  ]);
  const oldestPending = pendingVerification.at(-1);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{pendingVerification.length}</CardTitle>
          <CardDescription>
            Receipts awaiting verification
            {oldestPending ? ` — oldest ${formatDateTime(oldestPending.receivedOn)}` : ""}
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Payout batches</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {batchesByStatus.length === 0 ? (
            <p className="text-muted-foreground">No batches yet.</p>
          ) : (
            batchesByStatus.map((row) => (
              <div key={row.status} className="flex justify-between tabular-nums">
                <span className="text-muted-foreground">{row.status}</span>
                <span>{row._count}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function OpenItemsSummary({ db, orgId }: { db: ReturnType<typeof getPrismaClient>; orgId: string }) {
  const [projectCount, unitCount, leadCount] = await Promise.all([
    db.project.count({ where: { orgId } }),
    db.unit.count({ where: { orgId } }),
    db.lead.count({ where: { orgId, stage: { notIn: ["BOOKED", "LOST", "DORMANT"] } } }),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your open items</CardTitle>
        <CardDescription>Organization overview</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Projects</p>
          <p className="font-medium tabular-nums">{projectCount}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Units</p>
          <p className="font-medium tabular-nums">{unitCount}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Open leads</p>
          <p className="font-medium tabular-nums">{leadCount}</p>
        </div>
      </CardContent>
    </Card>
  );
}
