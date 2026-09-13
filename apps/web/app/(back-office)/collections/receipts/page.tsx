import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listReceipts } from "@desire/services/receipts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { enterReceiptAction, verifyReceiptAction, clearReceiptAction, bounceReceiptAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Receipts — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const MODES = ["CHEQUE", "NEFT", "RTGS", "IMPS", "UPI", "CARD", "CASH", "DEMAND_DRAFT"];

/** Every receipt in the org, plus the enter/verify/clear/bounce maker-checker
 *  lifecycle inline per row. Allocating a receipt against specific demand
 *  lines is a real, separate feature (a many-to-many split UI) explicitly
 *  descoped for this slice -- see PROGRESS.md -- clearReceipt/bounceReceipt
 *  themselves work correctly whether or not a receipt has been explicitly
 *  allocated (allocateReceipt has its own auto-allocate-oldest-first mode). */
export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const receipts = await listReceipts(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Receipts</h1>
        <Link href="/collections" className="text-sm text-primary hover:underline">
          Back to Collections
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Enter a receipt</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={enterReceiptAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Input name="bookingNumber" placeholder="Booking # (required)" required />
            <Input name="amount" placeholder="Amount (₹)" required />
            <select name="mode" defaultValue="NEFT" className={FIELD_CLASS} required>
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <Input type="date" name="receivedOn" required />
            <Button type="submit" size="sm">
              Enter receipt
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No receipts.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Receipt #</th>
                  <th className="py-1.5 pr-4">Booking</th>
                  <th className="py-1.5 pr-4">Customer</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4">Received</th>
                  <th className="py-1.5 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className="py-1.5 pr-4">{receipt.receiptNumber}</td>
                    <td className="py-1.5 pr-4">
                      <Link href={`/bookings/${receipt.booking.id}`} className="hover:underline">
                        {receipt.booking.bookingNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{receipt.booking.customer.name}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(receipt.amount)}</td>
                    <td className="py-1.5 pr-4">{receipt.status}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(receipt.receivedOn)}</td>
                    <td className="py-1.5 pr-4">
                      {receipt.status === "ENTERED" ? (
                        <form action={verifyReceiptAction} className="inline">
                          <input type="hidden" name="receiptId" value={receipt.id} />
                          <input type="hidden" name="returnPath" value="/collections/receipts" />
                          <Button type="submit" size="xs">
                            Verify
                          </Button>
                        </form>
                      ) : null}
                      {receipt.status === "VERIFIED" || receipt.status === "CLEARED" ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {receipt.status === "VERIFIED" ? (
                            <form action={clearReceiptAction} className="flex items-center gap-1">
                              <input type="hidden" name="receiptId" value={receipt.id} />
                              <Input type="date" name="clearedOn" className="h-7 w-32 text-xs" required />
                              <Button type="submit" size="xs">
                                Clear
                              </Button>
                            </form>
                          ) : null}
                          <form action={bounceReceiptAction} className="flex items-center gap-1">
                            <input type="hidden" name="receiptId" value={receipt.id} />
                            <Input name="bounceReason" placeholder="Reason" className="h-7 w-28 text-xs" required />
                            <Button type="submit" size="xs" variant="destructive">
                              Bounce
                            </Button>
                          </form>
                        </div>
                      ) : null}
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
