import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listGradeHistory } from "@desire/services/grades";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Promotions — Desire",
};

/** Read-only history, not a mutation screen (docs/08-SCREENS.md's own
 *  framing). Backed by AssociateGrade rows, not HierarchyChangeLog -- see
 *  the correction note on listGradeHistory itself: HierarchyChangeLog
 *  records org-tree moves, a different concept from a grade change. A null
 *  `approvedById` distinguishes an auto-qualification (the nightly sweep)
 *  from a human decision. */
export default async function PromotionsPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const rows = await listGradeHistory(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Promotions</h1>
        <Link href="/network" className="text-sm text-primary hover:underline">
          Org tree
        </Link>
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No grade changes recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Associate</th>
                  <th className="py-1.5 pr-4">Grade</th>
                  <th className="py-1.5 pr-4">Effective from</th>
                  <th className="py-1.5 pr-4">Ended</th>
                  <th className="py-1.5 pr-4">Reason</th>
                  <th className="py-1.5 pr-4">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${row.associateId}`} className="hover:underline">
                        {row.associateName} ({row.associateCode})
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{row.gradeName}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(row.validFrom)}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{row.validTo ? formatDate(row.validTo) : "—"}</td>
                    <td className="py-1.5 pr-4">{row.reason ?? "—"}</td>
                    <td className="py-1.5 pr-4">{row.approvedById ? "Manual" : "Auto-qualified"}</td>
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
