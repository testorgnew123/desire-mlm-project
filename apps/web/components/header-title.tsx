"use client";

import { usePathname } from "next/navigation";
import { BACK_OFFICE_NAV, PWA_NAV } from "@/lib/nav";

const SHELLS = { "back-office": BACK_OFFICE_NAV, pwa: PWA_NAV } as const;

/** Derives the header's page title from the current path against the same
 *  nav tree that drives the sidebar, rather than threading a title through
 *  every page.tsx -- longest-href-prefix match so a detail route
 *  (/bookings/[id]) still shows its section's label ("Bookings"). Imports
 *  the nav constants itself (a `shell` string picks which one) rather than
 *  taking a NavItem[] prop -- NavItem now carries a `icon` component
 *  reference, and a Server Component can't pass that as a prop across the
 *  boundary into this Client Component (confirmed live: "Functions cannot
 *  be passed directly to Client Components" on every dashboard request). */
export function HeaderTitle({ shell }: { shell: keyof typeof SHELLS }) {
  const pathname = usePathname();
  const nav = SHELLS[shell];
  const match = [...nav]
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  // Not an <h1> -- each page already renders its own top-level heading;
  // this is shell chrome (like a breadcrumb), and a second h1 per page would
  // be a real, needless accessibility regression, not just a visual one.
  return <p className="text-sm font-medium">{match?.label ?? "Desire"}</p>;
}
