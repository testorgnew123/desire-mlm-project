import type { Metadata } from "next";
import { getPrismaClient } from "@desire/db";
import { getEarnings } from "@desire/services/commission";
import { listNotifications } from "@desire/services/notifications";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { formatIstClock } from "@/app/board/[projectId]/format";
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
      <main className="p-4">
        <p className="text-sm text-muted-foreground">
          No associate record found for {session.user.name}. Nothing to show yet.
        </p>
      </main>
    );
  }

  const earnings = await getEarnings(db, {
    associateId: associate.id,
    audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
  });

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
    <main className="flex flex-col gap-4 p-4">
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
      </div>

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
    </main>
  );
}
