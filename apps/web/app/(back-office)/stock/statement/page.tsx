import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2 } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { getStockStatement } from "@desire/services/units";
import { requireSession } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { unitStatusTone } from "@/lib/status-tone";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stock statement — Desire",
};

/** Units grouped by tower/type/status for one project (Slice 8) -- no
 *  existing aggregation covered this shape (getUnitDeltas is a flat
 *  per-unit list, not a grouped count). */
export default async function StockStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const session = await requireSession();
  const db = getPrismaClient();
  try {
    await assertPermission(db, session.user.id, "unit.read");
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }

  const { projectId } = await searchParams;

  const projects = await db.project.findMany({
    where: { orgId: session.user.orgId },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });

  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Stock statement</h1>
        <p className="text-sm text-muted-foreground">Pick a project.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/stock/statement?projectId=${project.id}`}>
              <Card>
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>{project.code}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) notFound();

  const rows = await getStockStatement(db, { orgId: session.user.orgId, projectId });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Stock statement</h1>
        <p className="text-sm text-muted-foreground">{project.name}</p>
      </div>
      <Card>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyState icon={Building2} message="No units yet." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Tower</th>
                  <th className="py-1.5 pr-4">Unit type</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4 text-right">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td className="py-1.5 pr-4">{row.towerName ?? "—"}</td>
                    <td className="py-1.5 pr-4">{row.unitTypeName}</td>
                    <td className="py-1.5 pr-4">
                      <StatusBadge status={row.status} tone={unitStatusTone(row.status)} />
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
