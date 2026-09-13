import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin — Desire",
};

/** Phase 3.5 Slice 15. Config is explicitly descoped -- no schema/backend
 *  exists for arbitrary org config as far as verified; that needs a schema
 *  decision before any screen, not guessed here. */
export default async function AdminPage() {
  await requireSession();

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Admin</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/admin/users">
          <Card className="h-full transition-colors hover:bg-muted">
            <CardHeader>
              <CardTitle>Users &amp; Roles</CardTitle>
              <CardDescription>Create accounts, assign roles</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/audit-log">
          <Card className="h-full transition-colors hover:bg-muted">
            <CardHeader>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>Every recorded action, filterable</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/notification-rules">
          <Card className="h-full transition-colors hover:bg-muted">
            <CardHeader>
              <CardTitle>Notification rules</CardTitle>
              <CardDescription>Who gets notified about what, and when</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Card className="h-full opacity-60">
          <CardHeader>
            <CardTitle>Config</CardTitle>
            <CardDescription>Deferred — no org-config data model exists yet; needs a schema decision first.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </main>
  );
}
