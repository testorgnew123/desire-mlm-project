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

/** Project picker -- the PWA inventory tab's landing (docs/08-SCREENS.md:
 *  "Inventory -- Browse, filter, unit detail, hold"). Unit browsing itself
 *  is per-project, same as the desktop board. */
export default async function PwaInventoryPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const projects = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: { id: true, code: true, name: true, city: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Inventory</h1>
      {projects.length === 0 ? (
        <EmptyState icon={Building2} message="No projects yet." />
      ) : (
        projects.map((project) => (
          <Link key={project.id} href={`/inventory/${project.id}`}>
            <Card>
              <CardHeader>
                <CardTitle>{project.name}</CardTitle>
                <CardDescription>
                  {project.code} · {project.city}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))
      )}
    </div>
  );
}
