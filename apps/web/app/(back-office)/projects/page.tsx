import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Projects — Desire",
};

/** List (docs/08-SCREENS.md: "Projects -- List Detail Towers Units Price
 *  lists Payment plans Commission scheme"). */
export default async function ProjectsPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const projects = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: {
      id: true,
      code: true,
      name: true,
      city: true,
      _count: { select: { towers: true, units: true } },
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Projects</h1>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card>
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>
                    {project.code} · {project.city}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex gap-4 text-sm text-muted-foreground">
                  <span>{project._count.towers} tower(s)</span>
                  <span>{project._count.units} unit(s)</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
