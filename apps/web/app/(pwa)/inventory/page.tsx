import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "Inventory — Desire",
};

/** Projects per page: a phone shows a handful at a time. */
const PAGE_SIZE = 30;

/** Project picker -- the PWA inventory tab's landing (docs/08-SCREENS.md:
 *  "Inventory -- Browse, filter, unit detail, hold"). Unit browsing itself
 *  is per-project, same as the desktop board. Paged, like the desktop list. */
export default async function PwaInventoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: rawPage } = await searchParams;
  // Clamped so a hand-edited ?page= cannot ask the database for an offset it cannot hold.
  const page = Math.min(1000, Math.max(1, Math.floor(Number(rawPage)) || 1));
  const session = await requireSession();
  const db = getPrismaClient();

  // One row more than the page, to learn whether a next page exists without a count query.
  const fetched = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: { id: true, code: true, name: true, city: true },
    // The id breaks ties between equal names, so a project never lands on two pages.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const projects = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Inventory</h1>
      {projects.length === 0 && page === 1 ? (
        <EmptyState icon={Building2} message="No projects yet." />
      ) : (
        projects.map((project) => (
          <Link key={project.id} href={`/inventory/${project.id}`}>
            <Card>
              <CardHeader>
                <CardTitle>{project.name}</CardTitle>
                <CardDescription>
                  {[project.code, project.city].filter(Boolean).join(" · ")}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))
      )}
      {page > 1 || hasNext ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={`/inventory?page=${page - 1}`} className="text-primary hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">Page {page}</span>
          {hasNext ? (
            <Link href={`/inventory?page=${page + 1}`} className="text-primary hover:underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
