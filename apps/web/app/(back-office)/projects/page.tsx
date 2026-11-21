import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { describeGroupCounts } from "@/lib/groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "Projects — Desire",
};

/** Projects per page: a multiple of three, the widest the card grid gets. */
const PAGE_SIZE = 24;

/** List (docs/08-SCREENS.md: "Projects -- List Detail Towers Units Price
 *  lists Payment plans Commission scheme"). Paged, so the day a developer has a
 *  hundred projects the page does not carry every card and count at once. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: rawPage } = await searchParams;
  // Clamped so a hand-edited ?page= cannot ask the database for an offset it cannot hold.
  const page = Math.min(1000, Math.max(1, Math.floor(Number(rawPage)) || 1));
  const session = await requireSession();
  const db = getPrismaClient();

  // One row more than the page, to learn whether a next page exists without a count query.
  const fetched = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: {
      id: true,
      code: true,
      name: true,
      city: true,
      towers: { select: { kind: true } },
      _count: { select: { units: true } },
    },
    // The id breaks ties between equal names, so a project never lands on two pages.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const projects = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button size="sm" nativeButton={false} render={<Link href="/projects/new" />}>
          <Plus className="size-4" />
          New project
        </Button>
      </div>
      {projects.length === 0 && page === 1 ? (
        /* Until this button existed, an org with no seed data saw "No projects
           yet." and had no way forward -- createProject had no caller at all. */
        <EmptyState icon={Building2} message="No projects yet. Create the first one to begin." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const towerCount = project.towers.filter((group) => group.kind === "TOWER").length;
            const blockCount = project.towers.length - towerCount;
            return (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card>
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>
                    {[project.code, project.city].filter(Boolean).join(" · ")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex gap-4 text-sm text-muted-foreground">
                  <span>{describeGroupCounts(towerCount, blockCount)}</span>
                  <span>{project._count.units} unit(s)</span>
                </CardContent>
              </Card>
            </Link>
            );
          })}
        </div>
      )}
      {page > 1 || hasNext ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={`/projects?page=${page - 1}`} className="text-primary hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">Page {page}</span>
          {hasNext ? (
            <Link href={`/projects?page=${page + 1}`} className="text-primary hover:underline">
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
