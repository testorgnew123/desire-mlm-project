import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listSchemes } from "@desire/services/schemes";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Schemes — Desire",
};

/** Browsing across every project -- Phase 3.5 Slice 13 -- confirmed gap,
 *  closed with the new listSchemes (getSchemeById/getActiveScheme each
 *  resolve exactly one). Creating/publishing a scheme stays on the Projects
 *  detail page (Slice 7) -- that's where a scheme belongs to one project's
 *  configuration; this screen is the cross-project browse/simulate view. */
export default async function SchemesPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const schemes = await listSchemes(db, { orgId: session.user.orgId, actorId: session.user.id });
  const projectIds = [...new Set(schemes.map((s) => s.projectId))];
  const projects = projectIds.length
    ? await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, code: true } })
    : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Schemes</h1>
        <Link href="/commission" className="text-sm text-primary hover:underline">
          Ledger
        </Link>
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {schemes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No schemes.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Project</th>
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4 text-right">Version</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4">Grade rates</th>
                  <th className="py-1.5 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {schemes.map((scheme) => (
                  <tr key={scheme.id}>
                    <td className="py-1.5 pr-4">{projectById.get(scheme.projectId)?.name ?? "—"}</td>
                    <td className="py-1.5 pr-4">
                      <Link href={`/projects/${scheme.projectId}`} className="hover:underline">
                        {scheme.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{scheme.version}</td>
                    <td className="py-1.5 pr-4">{scheme.status}</td>
                    <td className="py-1.5 pr-4">
                      {scheme.gradeRates.map((r) => `${r.grade.code}: ${r.rateValue.toString()}${r.rateType === "PCT_OF_BASE" ? "%" : ""}`).join(", ")}
                    </td>
                    <td className="py-1.5 pr-4">
                      <Link href={`/commission/schemes/${scheme.id}/simulate`} className="text-xs text-primary hover:underline">
                        Simulate
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
