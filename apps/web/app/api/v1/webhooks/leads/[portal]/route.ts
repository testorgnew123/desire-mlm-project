// Portal lead ingestion webhook -- POST /webhooks/leads/:portal.
// docs/16-ROADMAP.md / PROGRESS.md Phase 5 "Portal lead ingestion". Payload
// shape and auth header are explicitly PLACEHOLDER -- no real 99acres/
// MagicBricks/Housing API document exists to build against (same status as
// bookingNumber's format). Real field names and possibly the auth scheme
// will need adjusting once an actual portal account exists; the mechanism
// (shared-secret auth, per-portal LeadSource mapping, idempotent dedup) is
// real. See packages/services/src/portal-leads.ts.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { ingestPortalLead, UnknownPortalError } from "@desire/services/portal-leads";

export const dynamic = "force-dynamic";

function problemResponse(params: { status: number; type: string; title: string; detail: string; instance: string }): Response {
  return Response.json(
    {
      type: `https://docs.internal/errors/${params.type}`,
      title: params.title,
      status: params.status,
      detail: params.detail,
      instance: params.instance,
    },
    { status: params.status, headers: { "content-type": "application/problem+json" } },
  );
}

/** Same constant-time-compare pattern as every job route's x-job-secret --
 *  this endpoint is reachable from the open internet and belongs to no
 *  logged-in session, so a naive === check would leak the secret one byte
 *  at a time via timing. */
function isAuthorizedWebhook(provided: string | null): boolean {
  const expected = process.env.LEAD_WEBHOOK_SECRET;
  if (!expected) {
    console.error("LEAD_WEBHOOK_SECRET is not set; the portal lead webhook rejects every request.");
    return false;
  }
  if (provided === null) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

interface PortalLeadPayload {
  orgId?: unknown;
  externalLeadId?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  projectCode?: unknown;
  message?: unknown;
}

export async function POST(request: Request, { params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params;
  const url = new URL(request.url);

  if (!isAuthorizedWebhook(request.headers.get("x-webhook-secret"))) {
    return problemResponse({
      status: 401, type: "webhook-unauthorized", title: "Unauthorized",
      detail: "A valid x-webhook-secret header is required.", instance: url.pathname,
    });
  }

  let body: PortalLeadPayload;
  try {
    body = (await request.json()) as PortalLeadPayload;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }

  if (typeof body.orgId !== "string" || typeof body.externalLeadId !== "string" || typeof body.name !== "string" || typeof body.phone !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "orgId, externalLeadId, name and phone (all strings) are required.", instance: url.pathname,
    });
  }

  try {
    const lead = await ingestPortalLead(getPrismaClient(), {
      orgId: body.orgId,
      portal: portal.toUpperCase(),
      externalLeadId: body.externalLeadId,
      name: body.name,
      phone: body.phone,
      email: typeof body.email === "string" ? body.email : null,
      projectCode: typeof body.projectCode === "string" ? body.projectCode : null,
      message: typeof body.message === "string" ? body.message : null,
    });

    return Response.json({ id: lead.id }, { status: 201 });
  } catch (error) {
    if (error instanceof UnknownPortalError) {
      return problemResponse({
        status: 404, type: "unknown-portal", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
