import type { Metadata } from "next";
import { getPrismaClient, Prisma } from "@desire/db";
import { getEarnings } from "@desire/services/commission";
import { listNotifications } from "@desire/services/notifications";
import { getAccessibleAssociateIds } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { formatIstClock } from "@/app/board/[projectId]/format";
import { getGradeProgress } from "@desire/services/grades";
import { getCollectionsConsole } from "@desire/services/collections-sweep";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Home — Desire",
};

/** ASSOCIATE/TEAM_LEAD landing (docs/08-SCREENS.md Home tab: "today's
 *  tasks, alerts, this-month stats"): today's task count + unread alert
 *  count, earnings blocked-by-collections, today's scheduled site visits,
 *  and recent notifications. */
export default async function PwaHomePage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const associate = await db.associate.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (!associate) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">
          No associate record found for {session.user.name}. Nothing to show yet.
        </p>
      </div>
    );
  }

  const earnings = await getEarnings(db, {
    associateId: associate.id,
    audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
  });

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [thisMonthBookings, gradeProgress] = await Promise.all([
    db.booking.count({ where: { sellingAssociateId: associate.id, status: { not: "CANCELLED" }, bookingDate: { gte: startOfMonth } } }),
    getGradeProgress(db, { associateId: associate.id }),
  ]);

  const roleCodes = await getRoleCodes(db, session.user.id);
  const isTeamLead = roleCodes.has("TEAM_LEAD");
  const teamStats = isTeamLead ? await getTeamStats(db, { orgId: session.user.orgId, actorId: session.user.id, associateId: associate.id }) : null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const todaysVisits = await db.siteVisit.findMany({
    where: {
      associateId: associate.id,
      scheduledAt: { gte: startOfToday, lt: startOfTomorrow },
      cancelledAt: null,
      completedAt: null,
    },
    select: {
      id: true,
      scheduledAt: true,
      lead: { select: { name: true, phone: true } },
    },
    orderBy: { scheduledAt: "asc" },
  });

  const notifications = await listNotifications(db, { userId: session.user.id });
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  const recentNotifications = notifications.slice(0, 5);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Hi, {session.user.name.split(" ")[0]}</h1>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>{todaysVisits.length}</CardTitle>
            <CardDescription>Today&apos;s tasks</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{unreadCount}</CardTitle>
            <CardDescription>Unread alerts</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{thisMonthBookings}</CardTitle>
            <CardDescription>This month&apos;s bookings</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{gradeProgress.currentGradeName ?? "Ungraded"}</CardTitle>
            <CardDescription>Current grade</CardDescription>
          </CardHeader>
        </Card>
      </div>

      {gradeProgress.nextGradeName ? (
        <Card>
          <CardHeader>
            <CardTitle>Progress to {gradeProgress.nextGradeName}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {gradeProgress.thresholds.length === 0 ? (
              <p className="text-muted-foreground">No auto-qualification thresholds configured for this grade.</p>
            ) : (
              gradeProgress.thresholds.map((threshold) => (
                <div key={threshold.label} className="flex justify-between">
                  <span className={threshold.met ? "text-muted-foreground" : ""}>{threshold.label}</span>
                  <span className="tabular-nums">
                    {threshold.current} / {threshold.required} {threshold.met ? "✓" : ""}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      {teamStats ? (
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
            <CardDescription>Your downline</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Bookings this month</p>
              <p className="font-medium tabular-nums">{teamStats.bookingsThisMonth}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Open pipeline</p>
              <p className="font-medium tabular-nums">{teamStats.openPipeline}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Overdue collections</p>
              <p className="font-medium tabular-nums">{teamStats.overdueCollections}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Team earnings (payable)</p>
              <p className="font-medium tabular-nums">{formatMoney(teamStats.teamEarningsPayable)}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Earnings</CardTitle>
          <CardDescription>Accrued and payable commission</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Payable</p>
            <p className="font-medium tabular-nums">{formatMoney(earnings.payable)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="font-medium tabular-nums">{formatMoney(earnings.paid)}</p>
          </div>
          <div className="col-span-2 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {formatMoney(earnings.blocked)} blocked by {formatMoney(earnings.pendingCollections)} in pending
              collections
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s follow-ups</CardTitle>
          <CardDescription>Scheduled site visits</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {todaysVisits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No site visits scheduled today.</p>
          ) : (
            todaysVisits.map((visit) => (
              <div key={visit.id} className="flex items-center justify-between text-sm">
                <span>{visit.lead.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatIstClock(visit.scheduledAt.toISOString())}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>{unreadCount} unread</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {recentNotifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          ) : (
            recentNotifications.map((notification) => (
              <div key={notification.id} className="flex flex-col gap-0.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className={notification.readAt ? "text-muted-foreground" : "font-medium"}>
                    {notification.title}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(notification.createdAt)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{notification.body}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function getRoleCodes(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<Set<string>> {
  const userRoles = await db.userRole.findMany({ where: { userId }, select: { role: { select: { code: true } } } });
  return new Set(userRoles.map((userRole) => userRole.role.code));
}

interface TeamStats {
  bookingsThisMonth: number;
  openPipeline: number;
  overdueCollections: number;
  teamEarningsPayable: Prisma.Decimal;
}

/** docs/20-REPORTS.md's Team dashboard row: "downline bookings, pipeline,
 *  overdue collections, team earnings" -- the one dashboard among the five
 *  this project's TEAM_LEAD/ASSOCIATE split had never built (they land on
 *  this PWA page, not the back-office /dashboard, and it showed only the
 *  viewer's own data until now). accessibleIds already includes the team
 *  lead themself (getAccessibleAssociateIds's own convention), which is
 *  correct here -- "downline" tiles on a manager's own home screen
 *  conventionally include their own numbers too. */
async function getTeamStats(
  db: ReturnType<typeof getPrismaClient>,
  params: { orgId: string; actorId: string; associateId: string },
): Promise<TeamStats> {
  const accessibleIds = await getAccessibleAssociateIds(db, params.associateId, "OWN_AND_DOWNLINE");

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [bookingsThisMonth, openPipeline, consoleRows, earningsAgg] = await Promise.all([
    db.booking.count({ where: { sellingAssociateId: { in: accessibleIds }, status: { not: "CANCELLED" }, bookingDate: { gte: startOfMonth } } }),
    db.lead.count({ where: { assignedAssociateId: { in: accessibleIds }, stage: { notIn: ["BOOKED", "LOST", "DORMANT"] } } }),
    getCollectionsConsole(db, { orgId: params.orgId, actorId: params.actorId }),
    db.commissionEntry.aggregate({
      where: { beneficiaryAssociateId: { in: accessibleIds }, status: "PAYABLE" },
      _sum: { grossAmount: true },
    }),
  ]);

  return {
    bookingsThisMonth,
    openPipeline,
    overdueCollections: consoleRows.filter((row) => accessibleIds.includes(row.sellingAssociateId)).length,
    teamEarningsPayable: earningsAgg._sum.grossAmount ?? new Prisma.Decimal(0),
  };
}
