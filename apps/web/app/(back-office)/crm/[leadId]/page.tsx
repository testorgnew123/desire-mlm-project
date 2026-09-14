import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { listLeads } from "@desire/services/leads";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { STAGE_LABELS, ACTIVITY_TYPE_LABELS } from "@/app/(pwa)/leads/constants";
import { reassignLeadAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lead — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Desktop lead detail -- same activity timeline data as the PWA screen,
 *  plus the back-office-only reassign action (docs/08-SCREENS.md CRM:
 *  "fuller columns and bulk actions (reassign)"). */
export default async function CrmLeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { leadId } = await params;
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const leads = await listLeads(db, { orgId: session.user.orgId, actorId: session.user.id });
  const lead = leads.find((candidate) => candidate.id === leadId);
  if (!lead) notFound();

  const [activities, siteVisits, associates, currentAssociate] = await Promise.all([
    db.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      include: { associate: { select: { user: { select: { name: true } } } } },
    }),
    db.siteVisit.findMany({ where: { leadId }, orderBy: { scheduledAt: "desc" } }),
    db.associate.findMany({
      where: { orgId: session.user.orgId },
      select: { id: true, code: true, user: { select: { name: true } } },
      orderBy: { code: "asc" },
    }),
    lead.assignedAssociateId
      ? db.associate.findUnique({ where: { id: lead.assignedAssociateId }, select: { code: true, user: { select: { name: true } } } })
      : null,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{lead.name}</h1>
        <p className="text-sm text-muted-foreground">
          {lead.phone} · {lead.source} · {STAGE_LABELS[lead.stage]}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Reassign</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Currently: {currentAssociate ? `${currentAssociate.user.name} (${currentAssociate.code})` : "Unassigned"}
            </p>
            <form action={reassignLeadAction} className="flex flex-col gap-2">
              <input type="hidden" name="leadId" value={lead.id} />
              <select name="toAssociateId" className={FIELD_CLASS} required defaultValue="">
                <option value="" disabled>
                  Choose an associate
                </option>
                {associates.map((associate) => (
                  <option key={associate.id} value={associate.id}>
                    {associate.user.name} ({associate.code})
                  </option>
                ))}
              </select>
              <Input name="reason" placeholder="Reason (required)" required />
              <Button type="submit" size="sm" className="self-start">
                Reassign
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Site visits</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {siteVisits.length === 0 ? (
              <p className="text-sm text-muted-foreground">None scheduled.</p>
            ) : (
              siteVisits.map((visit) => (
                <div key={visit.id} className="flex items-center justify-between text-sm">
                  <span>{formatDateTime(visit.scheduledAt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {visit.cancelledAt ? "Cancelled" : visit.completedAt ? "Completed" : "Scheduled"}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {activities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity logged yet.</p>
          ) : (
            activities.map((activity) => (
              <div key={activity.id} className="flex flex-col gap-0.5 border-b border-border pb-2 text-sm last:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{ACTIVITY_TYPE_LABELS[activity.type]}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(activity.createdAt)}</span>
                </div>
                {activity.toStage ? (
                  <p className="text-xs text-muted-foreground">
                    Stage: {activity.fromStage ? `${STAGE_LABELS[activity.fromStage]} → ` : ""}
                    {STAGE_LABELS[activity.toStage]}
                  </p>
                ) : null}
                {activity.notes ? <p className="text-xs text-muted-foreground">{activity.notes}</p> : null}
                {activity.associate ? <p className="text-xs text-muted-foreground">by {activity.associate.user.name}</p> : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
