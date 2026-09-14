import type { Metadata } from "next";
import Link from "next/link";
import { Receipt } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { listAdjustments } from "@desire/services/payouts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Adjustments — Desire",
};

/** Read-only -- see listAdjustments's own comment: this slice's route list
 *  creates no Adjustment-authoring endpoint, so this shows what exists
 *  (today, only commission.ts's resolveDispute creates one) rather than
 *  adding a manual-adjustment CRUD flow the plan never asked for. */
export default async function AdjustmentsPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const adjustments = await listAdjustments(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Adjustments</h1>
        <Link href="/payouts" className="text-sm text-primary hover:underline">
          Payouts
        </Link>
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {adjustments.length === 0 ? (
            <EmptyState icon={Receipt} message="No adjustments." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Associate</th>
                  <th className="py-1.5 pr-4">Type</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                  <th className="py-1.5 pr-4">Reason</th>
                  <th className="py-1.5 pr-4">Approved</th>
                  <th className="py-1.5 pr-4">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {adjustments.map((adjustment) => (
                  <tr key={adjustment.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${adjustment.associateId}`} className="hover:underline">
                        {adjustment.associate.user.name} ({adjustment.associate.code})
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{adjustment.type}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(adjustment.amount)}</td>
                    <td className="py-1.5 pr-4">{adjustment.reason}</td>
                    <td className="py-1.5 pr-4">{adjustment.approvedById ? "Yes" : "No"}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(adjustment.createdAt)}</td>
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
