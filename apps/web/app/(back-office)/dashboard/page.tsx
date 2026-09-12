import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Dashboard — Desire",
};

/** Placeholder -- Slice 2 (Phase 3.5 plan) replaces this with the real
 *  role-branched dashboard. This exists now only so Slice 1's post-login
 *  redirect (apps/web/app/page.tsx) has a real route to land on. */
export default async function DashboardPage() {
  const { user } = await requireSession();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <p className="text-sm text-muted-foreground">
        Signed in as {user.name} ({user.email}). Dashboard coming in Slice 2.
      </p>
    </main>
  );
}
