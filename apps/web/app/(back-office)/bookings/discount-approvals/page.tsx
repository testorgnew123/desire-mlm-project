import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listPendingDiscountRequests } from "@desire/services/discounts";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { decideDiscountAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Discount approvals — Desire",
};

/** The approval queue -- Phase 3.5 Slice 10 -- confirmed backend gap, closed
 *  with discounts.ts's new listPendingDiscountRequests. Already filtered to
 *  exactly the requests this actor could act on (band-eligible, not their
 *  own, still PENDING); decideDiscount re-checks all three anyway, so this
 *  is a genuine narrowing, not just a display convenience. */
export default async function DiscountApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const requests = await listPendingDiscountRequests(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Discount approvals</h1>
        <Link href="/bookings" className="text-sm text-primary hover:underline">
          Back to bookings
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {requests.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">No discount requests waiting on your decision.</p>
          </CardContent>
        </Card>
      ) : (
        requests.map((request) => (
          <Card key={request.id}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <Link href={`/bookings/${request.booking.id}`} className="font-medium hover:underline">
                    {request.booking.bookingNumber}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    {formatMoney(request.amount)} ({request.pctOfBase.toString()}%)
                  </p>
                </div>
              </div>
              <p className="text-sm">{request.justification}</p>
              <div className="flex gap-2">
                <form action={decideDiscountAction} className="flex flex-1 gap-2">
                  <input type="hidden" name="discountRequestId" value={request.id} />
                  <input type="hidden" name="approve" value="true" />
                  <Input name="decisionNote" placeholder="Decision note (optional)" />
                  <Button type="submit" size="sm">
                    Approve
                  </Button>
                </form>
                <form action={decideDiscountAction} className="flex flex-1 gap-2">
                  <input type="hidden" name="discountRequestId" value={request.id} />
                  <input type="hidden" name="approve" value="false" />
                  <Input name="decisionNote" placeholder="Rejection note (optional)" />
                  <Button type="submit" size="sm" variant="destructive">
                    Reject
                  </Button>
                </form>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
