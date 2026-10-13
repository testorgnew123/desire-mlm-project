"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { createProject } from "@desire/services/projects";
import { requireSession } from "@/lib/session";

/** Same discipline as projects/[projectId]/actions.ts: a caller without an
 *  ORG-WIDE project.write grant is a real, expected case (a project-scoped
 *  Project Manager cannot create a new project -- see createProject), as is a
 *  duplicate project code. Letting either throw uncaught lands on Next's
 *  generic error page; caught here and shown inline instead. These are
 *  internal back-office actors, so the service's own message is safe and
 *  useful to show verbatim. */
async function runCreate(run: () => Promise<string>): Promise<void> {
  let projectId: string;
  try {
    projectId = await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/projects/new?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}

/** Empty strings from a form are not the same as "not supplied" -- an empty
 *  text input must become null, not "". */
function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

function optionalDate(value: FormDataEntryValue | null): Date | null {
  const text = optional(value);
  return text === null ? null : new Date(text);
}

function optionalInt(value: FormDataEntryValue | null): number | undefined {
  const text = optional(value);
  return text === null ? undefined : Number(text);
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await runCreate(async () => {
    const project = await createProject(db, {
      code: String(formData.get("code") ?? "").trim(),
      name: String(formData.get("name") ?? "").trim(),
      city: String(formData.get("city") ?? "").trim(),
      state: String(formData.get("state") ?? "").trim(),

      // RERA is optional at creation on purpose: a PLANNING project has no
      // registration yet. holds.ts enforces it at the point it actually
      // matters -- the AVAILABLE -> HELD transition -- so a project can be
      // set up and populated before the number exists.
      reraRegNo: optional(formData.get("reraRegNo")),
      reraValidTill: optionalDate(formData.get("reraValidTill")),
      reraPortalUrl: optional(formData.get("reraPortalUrl")),

      addressLine1: optional(formData.get("addressLine1")),
      addressLine2: optional(formData.get("addressLine2")),
      pincode: optional(formData.get("pincode")),

      launchDate: optionalDate(formData.get("launchDate")),
      expectedPossessionDate: optionalDate(formData.get("expectedPossessionDate")),

      // Omitted means the schema default, which is what a user who left the
      // field alone means. Sending NaN from an empty input would not be.
      holdTtlMinutes: optionalInt(formData.get("holdTtlMinutes")),

      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
    return project.id;
  });
}
