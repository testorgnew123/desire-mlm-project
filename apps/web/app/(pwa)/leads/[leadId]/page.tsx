import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarClock, ClipboardList } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { listLeads } from "@desire/services/leads";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { STAGE_LABELS, ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, STAGES } from "../constants";
import { logActivityAction, scheduleSiteVisitAction } from "./actions";

export const metadata: Metadata = {
  title: "Lead — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Lead detail + activity timeline + "log activity" / "schedule site
 *  visit" forms (docs/08-SCREENS.md PWA Leads tab). Wires entirely to
 *  existing leads.ts -- no backend gap. The initial read reuses listLeads
 *  (already correctly scoped: ASSOCIATE own, TEAM_LEAD own + downline)
 *  rather than an unscoped direct lookup, since no scoped single-lead
 *  getter exists yet. */
export default async function LeadDetailPage({
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

  const [activities, siteVisits, project] = await Promise.all([
    db.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      include: { associate: { select: { user: { select: { name: true } } } } },
    }),
    db.siteVisit.findMany({ where: { leadId }, orderBy: { scheduledAt: "desc" } }),
    lead.projectId ? db.project.findUnique({ where: { id: lead.projectId }, select: { id: true, name: true } }) : null,
  ]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">{lead.name}</h1>
        <p className="text-sm text-muted-foreground">
          {lead.phone} · {STAGE_LABELS[lead.stage]}
        </p>
      </div>

      {error === "stage_required" ? (
        <p role="alert" className="text-sm text-danger">
          A stage-change activity needs a target stage.
        </p>
      ) : null}
      {error === "invalid_visit" ? (
        <p role="alert" className="text-sm text-danger">
          Pick a project and a valid date/time for the site visit.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Log activity</CardTitle>
          <CardDescription>Call, WhatsApp, meeting, note, or a stage change</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={logActivityAction} className="flex flex-col gap-3">
            <input type="hidden" name="leadId" value={lead.id} />
            <select name="type" defaultValue="CALL" className={FIELD_CLASS} required>
              {ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACTIVITY_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            {/* Only takes effect when type is "Stage change" -- logActivity
                ignores toStage for every other activity type, matching a
                real CRM's model of a stage move as its own event rather
                than an attribute tacked onto a call or note. */}
            <label className="text-xs text-muted-foreground" htmlFor="toStage">
              Move to stage (only if type is &quot;Stage change&quot;)
            </label>
            <select id="toStage" name="toStage" defaultValue="" className={FIELD_CLASS}>
              <option value="">No stage change</option>
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
            <textarea name="notes" placeholder="Notes" rows={3} className={FIELD_CLASS} />
            <Button type="submit">Log activity</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule site visit</CardTitle>
        </CardHeader>
        <CardContent>
          {project ? (
            <form action={scheduleSiteVisitAction} className="flex flex-col gap-3">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="projectId" value={project.id} />
              <p className="text-sm text-muted-foreground">{project.name}</p>
              <input type="datetime-local" name="scheduledAt" className={FIELD_CLASS} required />
              <Button type="submit">Schedule visit</Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              This lead has no project yet -- a site visit needs one.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Site visits</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {siteVisits.length === 0 ? (
            <EmptyState icon={CalendarClock} message="None scheduled." />
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

      <Card>
        <CardHeader>
          <CardTitle>Activity timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {activities.length === 0 ? (
            <EmptyState icon={ClipboardList} message="No activity logged yet." />
          ) : (
            activities.map((activity) => (
              <div key={activity.id} className="flex flex-col gap-0.5 border-b border-border pb-2 text-sm last:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{ACTIVITY_TYPE_LABELS[activity.type]}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(activity.createdAt)}
                  </span>
                </div>
                {activity.toStage ? (
                  <p className="text-xs text-muted-foreground">
                    Stage: {activity.fromStage ? `${STAGE_LABELS[activity.fromStage]} → ` : ""}
                    {STAGE_LABELS[activity.toStage]}
                  </p>
                ) : null}
                {activity.notes ? <p className="text-xs text-muted-foreground">{activity.notes}</p> : null}
                {activity.associate ? (
                  <p className="text-xs text-muted-foreground">by {activity.associate.user.name}</p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
