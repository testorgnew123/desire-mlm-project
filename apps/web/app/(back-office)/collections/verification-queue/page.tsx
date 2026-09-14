import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listReceipts } from "@desire/services/receipts";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { verifyReceiptAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verification queue — Desire",
};

/** listReceipts filtered to ENTERED -- the same list Receipts shows, at the
 *  one status finance actually needs to act on (docs/08-SCREENS.md's
 *  "Verification queue" is this same underlying data, not a second read). */
export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const receipts = await listReceipts(db, { orgId: session.user.orgId, actorId: session.user.id, status: "ENTERED" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Verification queue</h1>
        <Link href="/collections/receipts" className="text-sm text-primary hover:underline">
          All receipts
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardContent className="overflow-x-auto">
          {receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting on verification.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Receipt #</th>
                  <th className="py-1.5 pr-4">Booking</th>
                  <th className="py-1.5 pr-4">Customer</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                  <th className="py-1.5 pr-4">Received</th>
                  <th className="py-1.5 pr-4" />
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
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(receipt.receivedOn)}</td>
                    <td className="py-1.5 pr-4">
                      <form action={verifyReceiptAction}>
                        <input type="hidden" name="receiptId" value={receipt.id} />
                        <input type="hidden" name="returnPath" value="/collections/verification-queue" />
                        <Button type="submit" size="xs">
                          Verify
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
    </div>
  );
}
