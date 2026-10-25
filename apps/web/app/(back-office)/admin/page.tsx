import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isFeatureEnabled, type FeatureKey } from "@/lib/features";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin — Desire",
};

const ADMIN_SECTIONS: { feature: FeatureKey; href: string; title: string; description: string }[] = [
  { feature: "adminUsers", href: "/admin/users", title: "Users & Roles", description: "Create accounts, assign roles" },
  { feature: "auditLog", href: "/admin/audit-log", title: "Audit log", description: "Every recorded action, filterable" },
  {
    feature: "notifications",
    href: "/admin/notification-rules",
    title: "Notification rules",
    description: "Who gets notified about what, and when",
  },
];

/** The sections that are switched on (lib/features.ts). With only one left the
 *  hub would be a page of a single card, so it goes straight there.
 *
 *  Phase 3.5 Slice 15. Config is explicitly descoped -- no schema/backend
 *  exists for arbitrary org config as far as verified; that needs a schema
 *  decision before any screen, not guessed here. */
export default async function AdminPage() {
  await requireSession();

  const sections = ADMIN_SECTIONS.filter((section) => isFeatureEnabled(section.feature));
  const only = sections[0];
  if (sections.length === 1 && only) redirect(only.href);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Admin</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={section.href}>
            <Card className="h-full transition-colors hover:bg-muted">
              <CardHeader>
                <CardTitle>{section.title}</CardTitle>
                <CardDescription>{section.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
