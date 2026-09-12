import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { listActiveHolds } from "@desire/services/units";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Active holds — Desire",
};

/** Every live hold, org-wide -- the delta-since endpoint the board polls
 *  cannot answer "list them all", only "what changed" (docs/06-INVENTORY-
 *  SPEC.md section 6), so this reads listActiveHolds instead (Slice 8). */
export default async function ActiveHoldsPage() {
  const session = await requireSession();
  const db = getPrismaClient();
  try {
    await assertPermission(db, session.user.id, "unit.read");
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }

  const holds = await listActiveHolds(db, { orgId: session.user.orgId });

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Active holds</h1>
      <Card>
        <CardHeader>
          <CardTitle>{holds.length} hold(s)</CardTitle>
          <CardDescription>Live, not yet expired</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {holds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active holds.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Unit</th>
                  <th className="py-1.5 pr-4">Project</th>
                  <th className="py-1.5 pr-4">Held by</th>
                  <th className="py-1.5 pr-4">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holds.map((hold) => (
                  <tr key={hold.holdId}>
                    <td className="py-1.5 pr-4">{hold.unitNumber}</td>
                    <td className="py-1.5 pr-4">{hold.projectName}</td>
                    <td className="py-1.5 pr-4">
                      {hold.associateName} ({hold.associateCode})
                    </td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDateTime(hold.expiresAt)}</td>
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
