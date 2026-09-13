import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listRecoveries } from "@desire/services/payouts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recoveries — Desire",
};

export default async function RecoveriesPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const recoveries = await listRecoveries(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Recoveries</h1>
        <Link href="/payouts" className="text-sm text-primary hover:underline">
          Payouts
        </Link>
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {recoveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recoveries.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Associate</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                  <th className="py-1.5 pr-4 text-right">Outstanding</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4">Reason</th>
                  <th className="py-1.5 pr-4">Raised</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recoveries.map((recovery) => (
                  <tr key={recovery.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${recovery.associateId}`} className="hover:underline">
                        {recovery.associate.user.name} ({recovery.associate.code})
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(recovery.amount)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(recovery.outstandingAmount)}</td>
                    <td className="py-1.5 pr-4">{recovery.status}</td>
                    <td className="py-1.5 pr-4">{recovery.reason}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(recovery.createdAt)}</td>
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
