import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getCollectionsConsole } from "@desire/services/collections-sweep";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { promiseToPayAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collections — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const OUTCOMES = [
  "CONTACTED_WILL_PAY",
  "CONTACTED_DISPUTED",
  "CONTACTED_REQUESTED_EXTENSION",
  "NO_ANSWER",
  "WRONG_NUMBER",
  "ESCALATED",
];

type Bucket = "Current" | "1-30" | "31-60" | "61-90" | "90+";

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "Current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

/** Console (one row per open demand) + an aging summary built from the same
 *  rows -- docs/08-SCREENS.md's separate "Aging report" is this exact data
 *  regrouped by bucket, not a second aggregation query, so it is computed
 *  here rather than adding a duplicate read to collections-sweep.ts. */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const rows = await getCollectionsConsole(db, { orgId: session.user.orgId, actorId: session.user.id });

  const buckets: Bucket[] = ["Current", "1-30", "31-60", "61-90", "90+"];
  const agingSummary = buckets.map((bucket) => {
    const inBucket = rows.filter((row) => bucketFor(row.daysOverdue) === bucket);
    const total = inBucket.reduce((sum, row) => sum + Number(row.outstanding), 0);
    return { bucket, count: inBucket.length, total };
  });

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Collections</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/collections/receipts" className="text-primary hover:underline">
            Receipts
          </Link>
          <Link href="/collections/verification-queue" className="text-primary hover:underline">
            Verification queue
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
          <CardTitle>Aging summary</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                {agingSummary.map((b) => (
                  <th key={b.bucket} className="py-1.5 pr-4">
                    {b.bucket}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {agingSummary.map((b) => (
                  <td key={b.bucket} className="py-1.5 pr-4 tabular-nums">
                    {b.count} · {formatMoney(String(b.total))}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open demands</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open demands.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Booking</th>
                  <th className="py-1.5 pr-4">Customer</th>
                  <th className="py-1.5 pr-4 text-right">Outstanding</th>
                  <th className="py-1.5 pr-4">Due date</th>
                  <th className="py-1.5 pr-4 text-right">Days overdue</th>
                  <th className="py-1.5 pr-4">Log follow-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.demandId}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/bookings/${row.bookingId}`} className="font-medium hover:underline">
                        {row.bookingNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{row.customerName}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(row.outstanding)}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(row.dueDate)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.daysOverdue}</td>
                    <td className="py-1.5 pr-4">
                      <form action={promiseToPayAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="demandId" value={row.demandId} />
                        <select name="outcome" defaultValue="CONTACTED_WILL_PAY" className={`${FIELD_CLASS} w-auto`}>
                          {OUTCOMES.map((outcome) => (
                            <option key={outcome} value={outcome}>
                              {outcome.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                        <Input type="date" name="promiseToPayDate" className="w-auto" />
                        <Button type="submit" size="xs">
                          Log
                        </Button>
                      </form>
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
