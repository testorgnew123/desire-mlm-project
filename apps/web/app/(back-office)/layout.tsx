import type { ReactNode } from "react";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { BACK_OFFICE_NAV, filterNav } from "@/lib/nav";
import { HeaderTitle } from "@/components/header-title";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

/** The desktop back-office shell (docs/08-SCREENS.md: sidebar navigation,
 *  ~11 sections). Filters the nav tree to what this actor's permission set
 *  can reach -- a permission-set check, not a role-name string check, so a
 *  role that gains a permission later just works without a nav.ts edit. */
export default async function BackOfficeLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const db = getPrismaClient();
  const permissions = await getCachedSessionPermissions(db, session.user.id);
  const items = filterNav(BACK_OFFICE_NAV, permissions);

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="px-2 py-1.5 text-sm font-semibold">Desire</div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {/* `prefetch` on every link, deliberately.

                    Measured: prefetch does NOT change how many requests are
                    made -- every link in the shell is prefetched on every page
                    load either way, which is Next's own default. What it
                    changes is the RESPONSE: the default returns a ~27.7 KB
                    loading shell, identical for every route, and the click
                    still pays a full ~450 ms round trip; `prefetch` makes the
                    route actually render (31-64 KB plus its database work), so
                    a click inside the staleTimes.dynamic window (60 s) costs
                    nothing.

                    The trade is server compute: /dashboard's ~13 sequential
                    queries now run on every page load even for someone who
                    never opens it. Accepted knowingly -- if Neon CU-hours
                    climb, narrowing this back to the daily-driver routes is
                    the first lever to pull, before touching keep-warm. */}
                {items.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton render={<Link href={item.href} prefetch />}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <UserMenu name={session.user.name} email={session.user.email} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="flex-1">
            <HeaderTitle shell="back-office" />
          </div>
          <ThemeToggle />
        </header>
        <div className="flex-1 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
