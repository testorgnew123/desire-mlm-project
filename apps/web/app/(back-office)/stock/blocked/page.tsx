import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { listBlockedUnits } from "@desire/services/units";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Blocked units — Desire",
};

/** Every currently-BLOCKED unit org-wide, with reason and who blocked it
 *  (Slice 8) -- no existing full-list read covered this shape. */
export default async function BlockedUnitsPage() {
  const session = await requireSession();
  const db = getPrismaClient();
  try {
    await assertPermission(db, session.user.id, "unit.read");
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }

  const units = await listBlockedUnits(db, { orgId: session.user.orgId });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Blocked units</h1>
      <Card>
        <CardHeader>
          <CardTitle>{units.length} unit(s)</CardTitle>
          <CardDescription>Currently BLOCKED</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {units.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blocked units.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Unit</th>
                  <th className="py-1.5 pr-4">Project</th>
                  <th className="py-1.5 pr-4">Reason</th>
                  <th className="py-1.5 pr-4">Blocked by</th>
                  <th className="py-1.5 pr-4">Blocked at</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {units.map((unit) => (
                  <tr key={unit.unitId}>
                    <td className="py-1.5 pr-4">{unit.unitNumber}</td>
                    <td className="py-1.5 pr-4">{unit.projectName}</td>
                    <td className="py-1.5 pr-4">{unit.blockReason ?? "—"}</td>
                    <td className="py-1.5 pr-4">{unit.blockedByLabel ?? "—"}</td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {unit.blockedAt ? formatDateTime(unit.blockedAt) : "—"}
                    </td>
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
