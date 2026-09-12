import type { Metadata } from "next";
import Link from "next/link";
import type { LeadStage } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listLeads } from "@desire/services/leads";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { STAGES, STAGE_LABELS } from "./constants";

export const metadata: Metadata = {
  title: "Leads — Desire",
};

/** List, filter by stage (docs/08-SCREENS.md PWA Leads tab). Scoped exactly
 *  as listLeads documents: ASSOCIATE sees own, TEAM_LEAD own + downline. */
export default async function LeadsPage({
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

  return (
    <main className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Leads</h1>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <Link
          href="/leads"
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            !selectedStage ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
          }`}
        >
          All
        </Link>
        {STAGES.map((stageOption) => (
          <Link
            key={stageOption}
            href={`/leads?stage=${stageOption}`}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
              selectedStage === stageOption
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {STAGE_LABELS[stageOption]}
          </Link>
        ))}
      </div>

      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No leads.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {leads.map((lead) => (
            <li key={lead.id}>
              <Link href={`/leads/${lead.id}`} className="flex items-center justify-between px-3 py-3">
                <div>
                  <p className="font-medium">{lead.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {lead.phone} · {formatDate(lead.createdAt)}
                  </p>
                </div>
                <span className="text-xs font-medium text-muted-foreground">{STAGE_LABELS[lead.stage]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
