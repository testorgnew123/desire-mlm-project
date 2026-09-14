import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "Inventory — Desire",
};

/** Inventory hub (docs/08-SCREENS.md: "Inventory -- Live board · Stock
 *  statement · Active holds · Blocked units"). The live board is already
 *  built and stays at its own path (apps/web/app/board/[projectId]) --
 *  linked in here per-project, not moved. */
export default async function InventoryHubPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const projects = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Inventory</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/stock/holds">
          <Card>
            <CardHeader>
              <CardTitle>Active holds</CardTitle>
              <CardDescription>Every live hold, org-wide</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/stock/blocked">
          <Card>
            <CardHeader>
              <CardTitle>Blocked units</CardTitle>
              <CardDescription>Currently blocked, with reason</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/stock/statement">
          <Card>
            <CardHeader>
              <CardTitle>Stock statement</CardTitle>
              <CardDescription>Units by tower, type and status</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Live board</h2>
        {projects.length === 0 ? (
          <EmptyState icon={Building2} message="No projects yet." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/board/${project.id}`}>
                <Card>
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    <CardDescription>{project.code}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
