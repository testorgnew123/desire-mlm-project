import type { Metadata } from "next";
import Link from "next/link";
import type { LeadStage } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listLeads } from "@desire/services/leads";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CRM — Desire",
};

const STAGES: LeadStage[] = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "SITE_VISIT_SCHEDULED",
  "SITE_VISIT_DONE",
  "NEGOTIATION",
  "BOOKED",
  "LOST",
  "DORMANT",
];

/** Desktop re-skin of the PWA Leads screens' data -- fuller columns
 *  (source, assigned associate), org-wide via listLeads' own scoping
 *  (admin-shaped roles and AUDITOR see everything; ASSOCIATE/TEAM_LEAD see
 *  own/own+downline, same as the PWA). Bulk reassign is scoped down to a
 *  per-lead reassign action on the detail page for this slice -- a
 *  multi-select bulk UI is a real but separable enhancement, not required
 *  for a working reassign flow. */
export default async function CrmLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}) {
  const session = await requireSession();
  const db = getPrismaClient();
  const { stage } = await searchParams;
  const selectedStage = STAGES.includes(stage as LeadStage) ? (stage as LeadStage) : undefined;

  const leads = await listLeads(db, {
    orgId: session.user.orgId,
    actorId: session.user.id,
    stage: selectedStage,
  });

  const associateIds = [...new Set(leads.map((lead) => lead.assignedAssociateId).filter((id): id is string => id !== null))];
  const associates = associateIds.length
    ? await db.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, code: true, user: { select: { name: true } } } })
    : [];
  const associateById = new Map(associates.map((associate) => [associate.id, associate]));

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">CRM — Leads</h1>
        <Link href="/crm/source-roi" className="text-sm text-primary hover:underline">
          Source ROI
        </Link>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Link
          href="/crm"
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            !selectedStage ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
          }`}
        >
          All
        </Link>
        {STAGES.map((stageOption) => (
          <Link
            key={stageOption}
            href={`/crm?stage=${stageOption}`}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
              selectedStage === stageOption
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {stageOption}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {leads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4">Phone</th>
                  <th className="py-1.5 pr-4">Source</th>
                  <th className="py-1.5 pr-4">Stage</th>
                  <th className="py-1.5 pr-4">Assigned to</th>
                  <th className="py-1.5 pr-4">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((lead) => {
                  const associate = lead.assignedAssociateId ? associateById.get(lead.assignedAssociateId) : null;
                  return (
                    <tr key={lead.id}>
                      <td className="py-1.5 pr-4">
                        <Link href={`/crm/${lead.id}`} className="font-medium hover:underline">
                          {lead.name}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-4">{lead.phone}</td>
                      <td className="py-1.5 pr-4">{lead.source}</td>
                      <td className="py-1.5 pr-4">{lead.stage}</td>
                      <td className="py-1.5 pr-4">{associate ? `${associate.user.name} (${associate.code})` : "—"}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{formatDate(lead.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
