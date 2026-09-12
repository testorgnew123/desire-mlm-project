import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Home — Desire",
};

/** Placeholder -- Slice 2 (Phase 3.5 plan) replaces this with the real
 *  ASSOCIATE landing (earnings + today's follow-ups). This exists now only
 *  so Slice 1's post-login redirect (apps/web/app/page.tsx) has a real route
 *  to land on for PWA-role users. */
export default async function PwaHomePage() {
  const { user } = await requireSession();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <p className="text-sm text-muted-foreground">
        Signed in as {user.name} ({user.email}). Home tab coming in Slice 2.
      </p>
    </main>
  );
}
