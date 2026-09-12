import type { ReactNode } from "react";
import type { Viewport } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getSessionPermissions } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import { PWA_NAV, filterNav } from "@/lib/nav";

// "usable one-handed at 360px" applies to every PWA screen, not just the
// board (docs/08-SCREENS.md, docs/12-NFR.md).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/** The Associate PWA shell: 5-tab bottom nav (docs/08-SCREENS.md). Same
 *  permission-set filter as the back-office shell -- Team is hidden for a
 *  plain ASSOCIATE via the lead.reassign check, not a role-name string
 *  check. */
export default async function PwaLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const db = getPrismaClient();
  const permissions = await getSessionPermissions(db, session.user.id);
  const items = filterNav(PWA_NAV, permissions);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main className="flex-1 overflow-y-auto pb-16">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 flex h-16 border-t border-border bg-background">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground active:text-primary"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
