import type { Metadata } from "next";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { listPayoutBatches } from "@desire/services/payouts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { payoutBatchStatusTone } from "@/lib/status-tone";
import { prepareBatchAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payouts — Desire",
};

/** Phase 3.5 Slice 14 -- this whole section had no backend beyond the three
 *  mutations (prepare/approve/export), all with zero HTTP routes and no
 *  read at all. Closed with listPayoutBatches/getPayoutBatch this slice;
 *  Statements (PDF) explicitly descoped, same as the Allotment-letter PDF
 *  precedent from Phase 2 -- no PDF library exists anywhere in this repo,
 *  and adding one is a new-dependency decision this project always pauses
 *  on rather than pulling in silently as a side effect of a UI slice. */
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const batches = await listPayoutBatches(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Payouts</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/payouts/recoveries" className="text-primary hover:underline">
            Recoveries
          </Link>
          <Link href="/payouts/adjustments" className="text-primary hover:underline">
            Adjustments
          </Link>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Prepare a batch</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={prepareBatchAction} className="grid gap-2 sm:grid-cols-3">
            <Input type="date" name="periodStart" required />
            <Input type="date" name="periodEnd" required />
            <Button type="submit" size="sm">
              Prepare
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {batches.length === 0 ? (
            <EmptyState icon={Wallet} message="No payout batches." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Batch #</th>
                  <th className="py-1.5 pr-4">Period</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4 text-right">Net payable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/payouts/batches/${batch.id}`} className="font-medium hover:underline">
                        {batch.batchNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {formatDate(batch.periodStart)} – {formatDate(batch.periodEnd)}
                    </td>
                    <td className="py-1.5 pr-4">
                      <StatusBadge status={batch.status} tone={payoutBatchStatusTone(batch.status)} />
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(batch.totalNetPayable)}</td>
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
