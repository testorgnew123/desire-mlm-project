import type { Metadata } from "next";
import Link from "next/link";
import type { CommissionEntryStatus } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listCommissionEntries } from "@desire/services/commission";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { raiseDisputeAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Commission ledger — Desire",
};

const STATUSES: CommissionEntryStatus[] = ["ACCRUED", "PAYABLE", "PAID", "ON_HOLD", "REVERSED"];

/** The Ledger -- Phase 3.5 Slice 13 -- confirmed gap, closed with the new
 *  listCommissionEntries. Drill-down reuses the PWA's "Explain this number"
 *  page directly (Slice 5) rather than rebuilding it, per the plan; raising
 *  a dispute is inline here since raiseDispute needs nothing the ledger row
 *  doesn't already have. */
export default async function CommissionLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();
  const selectedStatus = STATUSES.includes(status as CommissionEntryStatus) ? (status as CommissionEntryStatus) : undefined;

  const entries = await listCommissionEntries(db, { orgId: session.user.orgId, actorId: session.user.id, status: selectedStatus });

  const associateIds = [...new Set(entries.map((e) => e.beneficiaryAssociateId))];
  const associates = associateIds.length
    ? await db.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, code: true, user: { select: { name: true } } } })
    : [];
  const associateById = new Map(associates.map((a) => [a.id, a]));

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Commission ledger</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/commission/schemes" className="text-primary hover:underline">
            Schemes
          </Link>
          <Link href="/commission/disputes" className="text-primary hover:underline">
            Disputes
          </Link>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Link
          href="/commission"
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            !selectedStatus ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
          }`}
        >
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/commission?status=${s}`}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
              selectedStatus === s ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commission entries.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Beneficiary</th>
                  <th className="py-1.5 pr-4">Role</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4">Accrued</th>
                  <th className="py-1.5 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry) => {
                  const associate = associateById.get(entry.beneficiaryAssociateId);
                  return (
                    <tr key={entry.id}>
                      <td className="py-1.5 pr-4">{associate ? `${associate.user.name} (${associate.code})` : entry.beneficiaryAssociateId}</td>
                      <td className="py-1.5 pr-4">
                        {entry.role === "OVERRIDE" ? `Override L${entry.level}` : "Self"}
                      </td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(entry.grossAmount)}</td>
                      <td className="py-1.5 pr-4">{entry.status}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{formatDateTime(entry.accruedAt)}</td>
                      <td className="py-1.5 pr-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link href={`/earnings/${entry.id}/explain`} className="text-xs text-primary hover:underline">
                            Explain
                          </Link>
                          {entry.status !== "ON_HOLD" && entry.status !== "REVERSED" ? (
                            <form action={raiseDisputeAction} className="flex items-center gap-1">
                              <input type="hidden" name="entryId" value={entry.id} />
                              <Input name="description" placeholder="Dispute reason" className="h-7 w-32 text-xs" required />
                              <Button type="submit" size="xs" variant="destructive">
                                Dispute
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
