import type { Metadata } from "next";
import { getPrismaClient, Prisma } from "@desire/db";
import { getCollectionsConsole } from "@desire/services/collections-sweep";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Dashboard — Desire",
};

/** Roles with a full project-level stock + booking overview. */
const STOCK_OVERVIEW_ROLES = new Set(["SUPER_ADMIN", "SALES_HEAD", "PROJECT_MANAGER"]);

/** Role-branched landing (docs/08-SCREENS.md: "Dashboard -- Role-specific
 *  landing"). Deepened further in Slice 6; this is the real Slice 2
 *  minimum for every role that lands here -- ASSOCIATE/TEAM_LEAD never do,
 *  they land on the PWA Home tab instead (apps/web/app/page.tsx). */
export default async function DashboardPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const roleCodes = await getRoleCodes(db, session.user.id);

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Dashboard</h1>
      {roleCodes.has("FINANCE_ADMIN") ? (
        <CollectionsAgingSummary db={db} orgId={session.user.orgId} actorId={session.user.id} />
      ) : [...roleCodes].some((code) => STOCK_OVERVIEW_ROLES.has(code)) ? (
        <StockAndBookingSummary db={db} orgId={session.user.orgId} />
      ) : (
        <OpenItemsSummary db={db} orgId={session.user.orgId} />
      )}
    </main>
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
