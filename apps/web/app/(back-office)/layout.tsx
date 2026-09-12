import type { ReactNode } from "react";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getSessionPermissions } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import { BACK_OFFICE_NAV, filterNav } from "@/lib/nav";
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
  const permissions = await getSessionPermissions(db, session.user.id);
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
                {items.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton render={<Link href={item.href} />}>{item.label}</SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {session.user.name}
            <br />
            {session.user.email}
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <div className="flex-1 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
