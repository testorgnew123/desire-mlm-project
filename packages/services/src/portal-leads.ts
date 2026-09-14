// Portal lead ingestion (docs/16-ROADMAP.md Phase 5, `PROGRESS.md`
// "Portal lead ingestion"). Deliberately NOT leads.ts's createLead: that
// function requires a real session actor and RBAC check, and auto-assigns
// the new lead to the caller's own Associate row -- neither makes sense for
// an unattended webhook with no logged-in user. This creates an
// UNASSIGNED lead instead (no LeadClaim), for a sales admin/team lead to
// claim through the existing claim flow.
//
// **Payload shape is explicitly PLACEHOLDER.** No real 99acres/MagicBricks/
// Housing API document was available to build against -- same status as
// bookingNumber's format (packages/services/src/bookings.ts). The
// mechanism (auth, dedup, LeadSource mapping) is real; field names will
// need adjusting once a real portal account and its actual webhook payload
// exist.
import type { PrismaClient, Lead, LeadSource } from "@desire/db";
import { hashForDedup, normalizePhone } from "./leads";
import { writeAuditLog } from "./audit";

export const PORTAL_TO_LEAD_SOURCE: Record<string, LeadSource> = {
  "99ACRES": "PORTAL_99ACRES",
  MAGICBRICKS: "PORTAL_MAGICBRICKS",
  HOUSING: "PORTAL_HOUSING",
};

export class UnknownPortalError extends Error {
  constructor(portal: string) {
    super(`Unknown portal "${portal}".`);
  }
}

export interface IngestPortalLeadParams {
  orgId: string;
  portal: string;
  /** The portal's own id for this lead -- the only thing that makes a
   *  retried webhook delivery idempotent. Stored in sourceDetail since
   *  Lead has no dedicated external-id column. */
  externalLeadId: string;
  name: string;
  phone: string;
  email?: string | null;
  projectCode?: string | null;
  message?: string | null;
}

/** Idempotent on (orgId, source, sourceDetail=externalLeadId) via
 *  check-then-create, not unique-constraint-catch -- catching a Postgres
 *  unique violation mid-transaction aborts every later statement in that
 *  transaction, a real bug already found and fixed once in
 *  collections-sweep.ts's escalation ladder. No transaction is needed here
 *  anyway (a single check then a single create), but the lesson is why this
 *  is written as a lookup, not a try/catch. */
export async function ingestPortalLead(db: PrismaClient, params: IngestPortalLeadParams): Promise<Lead> {
  const source = PORTAL_TO_LEAD_SOURCE[params.portal];
  if (!source) throw new UnknownPortalError(params.portal);

  const existing = await db.lead.findFirst({
    where: { orgId: params.orgId, source, sourceDetail: params.externalLeadId },
  });
  if (existing) return existing;

  const phoneHash = hashForDedup(normalizePhone(params.phone));
  const emailHash = params.email ? hashForDedup(params.email.toLowerCase()) : null;

  const project = params.projectCode
    ? await db.project.findFirst({ where: { orgId: params.orgId, code: params.projectCode }, select: { id: true } })
    : null;

  const lead = await db.lead.create({
    data: {
      orgId: params.orgId,
      projectId: project?.id,
      name: params.name,
      phone: params.phone,
      email: params.email ?? undefined,
      phoneHash,
      emailHash: emailHash ?? undefined,
      source,
      sourceDetail: params.externalLeadId,
      requirementNote: params.message ?? undefined,
      // Unassigned on purpose -- a webhook has no caller to default to, and
      // fabricating a round-robin policy nobody has specified would be the
      // same mistake as inventing a Tally ledger mapping. A sales admin or
      // team lead claims it via the existing lead-claim flow.
      assignedAssociateId: undefined,
    },
  });

  await writeAuditLog(
    db,
    { orgId: params.orgId, actorId: null, actorLabel: `Portal webhook (${params.portal})` },
    { action: "CREATE", entity: "Lead", entityId: lead.id, after: { source, sourceDetail: params.externalLeadId } },
  );

  return lead;
}
