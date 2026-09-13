import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { getBookingForActor, previewCancellation } from "@desire/services/bookings";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatArea, formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requestDiscountAction, cancelBookingAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Detail + discount request (DRAFT only) + cancellation with a clawback
 *  preview (CONFIRMED only) -- docs/08-SCREENS.md's "Detail / Discount
 *  approvals / Cancellations" folded onto one page the way CRM's lead detail
 *  folded reassign + activity together in Slice 9, rather than three routes
 *  for what is really one booking's lifecycle. */
export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { bookingId } = await params;
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const booking = await getBookingForActor(db, { orgId: session.user.orgId, actorId: session.user.id, bookingId });
  if (!booking) notFound();

  const [project, unit, customer, discountRequests, clawbackPreview] = await Promise.all([
    db.project.findUnique({ where: { id: booking.projectId }, select: { name: true, code: true } }),
    db.unit.findUnique({ where: { id: booking.unitId }, select: { unitNumber: true } }),
    db.customer.findUnique({ where: { id: booking.customerId }, select: { name: true, phone: true } }),
    db.discountRequest.findMany({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    booking.status === "CONFIRMED" ? previewCancellation(db, { orgId: session.user.orgId, bookingId }) : Promise.resolve(null),
  ]);

  return (
    <main className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{booking.bookingNumber}</h1>
        <p className="text-sm text-muted-foreground">
          {project?.name} ({project?.code}) · Unit {unit?.unitNumber} · {customer?.name} · {booking.status}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Cost sheet</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-4">Charge</th>
                <th className="py-1.5 pr-4 text-right">Amount</th>
                <th className="py-1.5 pr-4 text-right">GST</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {booking.costSheetLines.map((line) => (
                <tr key={line.chargeHeadCode}>
                  <td className="py-1.5 pr-4">{line.description}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.amount)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.gstAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-col gap-1 text-sm">
            <p>
              Saleable area: {formatArea(booking.saleableAreaAtBooking, "saleable")} · Carpet area:{" "}
              {formatArea(booking.carpetAreaAtBooking, "carpet")}
            </p>
            <p className="font-medium">Agreement value: {formatMoney(booking.agreementValue)}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Discount requests</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {discountRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground">None requested.</p>
            ) : (
              discountRequests.map((request) => (
                <div key={request.id} className="flex flex-col gap-0.5 border-b border-border pb-2 text-sm last:border-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {formatMoney(request.amount)} ({request.pctOfBase.toString()}%)
                    </span>
                    <span className="text-xs text-muted-foreground">{request.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{request.justification}</p>
                  {request.decisionNote ? (
                    <p className="text-xs text-muted-foreground">Decision note: {request.decisionNote}</p>
                  ) : null}
                </div>
              ))
            )}

            {booking.status === "DRAFT" ? (
              <form action={requestDiscountAction} className="flex flex-col gap-2 border-t border-border pt-3">
                <input type="hidden" name="bookingId" value={booking.id} />
                <Input name="amount" placeholder="Discount amount (₹)" required />
                <Input name="pctOfBase" placeholder="% of base price" required />
                <Input name="justification" placeholder="Justification (required)" required />
                <Button type="submit" size="sm" className="self-start">
                  Request discount
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cancellation</CardTitle>
          </CardHeader>
          <CardContent>
            {booking.status !== "CONFIRMED" ? (
              <p className="text-sm text-muted-foreground">
                Only a CONFIRMED booking can be cancelled from here.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div>
                  <p className="mb-2 text-sm font-medium">Clawback preview</p>
                  {!clawbackPreview || clawbackPreview.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No commission entries to claw back.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-1.5 pr-4">Beneficiary</th>
                          <th className="py-1.5 pr-4">Role / Level</th>
                          <th className="py-1.5 pr-4 text-right">Recovery</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {clawbackPreview.map((line) => (
                          <tr key={line.commissionEntryId}>
                            <td className="py-1.5 pr-4">{line.beneficiaryAssociateId}</td>
                            <td className="py-1.5 pr-4">
                              {line.role} / L{line.level}
                            </td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(line.recoveryAmount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <form action={cancelBookingAction} className="flex flex-col gap-2 border-t border-border pt-3">
                  <input type="hidden" name="bookingId" value={booking.id} />
                  <textarea
                    name="reason"
                    placeholder="Cancellation reason (required)"
                    required
                    rows={2}
                    className={FIELD_CLASS}
                  />
                  <Button type="submit" size="sm" variant="destructive" className="self-start">
                    Cancel booking
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">Booked on {formatDate(booking.bookingDate)}</p>
    </main>
  );
}
