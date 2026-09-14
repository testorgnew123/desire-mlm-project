import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { getPayoutBatch } from "@desire/services/payouts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { payoutBatchStatusTone } from "@/lib/status-tone";
import { approveBatchAction, exportBatchAction } from "../../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payout batch — Desire",
};

/** Approve/export folded onto the detail page -- same "detail page owns its
 *  own actions" pattern as every other maker-checker screen this phase
 *  (CRM Slice 9, Bookings Slice 10, Network Slice 12). */
export default async function PayoutBatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { batchId } = await params;
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const batch = await getPayoutBatch(db, { batchId, orgId: session.user.orgId, actorId: session.user.id });
  if (!batch) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{batch.batchNumber}</h1>
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          {formatDate(batch.periodStart)} – {formatDate(batch.periodEnd)} ·{" "}
          <StatusBadge status={batch.status} tone={payoutBatchStatusTone(batch.status)} />
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div>
            <p className="text-xs text-muted-foreground">Gross</p>
            <p className="font-medium">{formatMoney(batch.totalGross)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">TDS</p>
            <p className="font-medium">{formatMoney(batch.totalTds)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">GST</p>
            <p className="font-medium">{formatMoney(batch.totalGst)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Recovery</p>
            <p className="font-medium">{formatMoney(batch.totalRecovery)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net payable</p>
            <p className="font-medium">{formatMoney(batch.totalNetPayable)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {batch.status === "DRAFT" ? (
            <form action={approveBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <Button type="submit" size="sm">
                Approve
              </Button>
            </form>
          ) : null}
          {batch.status === "APPROVED" ? (
            <form action={exportBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <Button type="submit" size="sm">
                Export bank file
              </Button>
            </form>
          ) : null}
          {batch.status === "EXPORTED" ? (
            <>
              <a
                href={`/api/v1/payouts/batches/${batch.id}/export?file=bank`}
                className="text-sm text-primary hover:underline"
              >
                Download bank file
              </a>
              <a
                href={`/api/v1/payouts/batches/${batch.id}/export?file=payroll`}
                className="text-sm text-primary hover:underline"
              >
                Download payroll handoff
              </a>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines ({batch.lines.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {batch.lines.length === 0 ? (
            <EmptyState icon={ClipboardList} message="No lines." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Associate</th>
                  <th className="py-1.5 pr-4 text-right">Gross</th>
                  <th className="py-1.5 pr-4 text-right">TDS</th>
                  <th className="py-1.5 pr-4 text-right">GST</th>
                  <th className="py-1.5 pr-4 text-right">Net payable</th>
                  <th className="py-1.5 pr-4">Statement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batch.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${line.associateId}`} className="hover:underline">
                        {line.associate.user.name} ({line.associate.code})
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.grossAmount)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.tdsAmount)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.gstAmount)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.netPayable)}</td>
                    <td className="py-1.5 pr-4">
                      <a
                        href={`/api/v1/payouts/lines/${line.id}/statement`}
                        className="text-primary hover:underline"
                      >
                        Download
                      </a>
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
