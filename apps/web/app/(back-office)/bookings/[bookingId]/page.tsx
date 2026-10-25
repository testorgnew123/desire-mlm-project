import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { getBookingForActor } from "@desire/services/bookings";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatArea, formatMoney } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { StatusBadge } from "@/components/status-badge";
import { bookingStatusTone } from "@/lib/status-tone";
import { cancelBookingAction, confirmBookingAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** One booking's whole lifecycle on one page: a draft an associate made is
 *  confirmed here by an admin, and a confirmed one can be cancelled with a
 *  reason. The discount request, payment schedule and clawback preview that used
 *  to sit here belong to switched-off features (apps/web/lib/features.ts). */
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

  const [booking, permissions] = await Promise.all([
    getBookingForActor(db, { orgId: session.user.orgId, actorId: session.user.id, bookingId }),
    getCachedSessionPermissions(db, session.user.id),
  ]);
  if (!booking) notFound();

  const [project, unit, customer, hold] = await Promise.all([
    db.project.findUnique({ where: { id: booking.projectId }, select: { name: true, code: true } }),
    db.unit.findUnique({
      where: { id: booking.unitId },
      select: { unitNumber: true, unitType: { select: { areaBasis: true } } },
    }),
    db.customer.findUnique({ where: { id: booking.customerId }, select: { name: true, phone: true, email: true } }),
    // The draft's reservation: if it has lapsed, the plot is no longer held for
    // this sale and confirming will be refused. Only a draft has one to show.
    booking.status === "DRAFT"
      ? db.unitHold.findFirst({
          where: { unitId: booking.unitId, releasedAt: null },
          select: { expiresAt: true, associate: { select: { code: true, user: { select: { name: true } } } } },
        })
      : Promise.resolve(null),
  ]);

  // Areas are labelled with their unit: a plot is priced in square yards, and
  // reading one as square feet is a ninefold mistake.
  const basis = unit?.unitType.areaBasis ?? "SQFT";
  const holdLive = !!hold && hold.expiresAt > new Date();
  const canConfirm = booking.status === "DRAFT" && permissions.has("booking.confirm");
  const canCancel = booking.status === "CONFIRMED" && permissions.has("booking.cancel");

  const priceRows: [label: string, amount: typeof booking.baseAmount, show: boolean][] = [
    ["Base price", booking.baseAmount, true],
    ["Preferential location charge", booking.plcAmount, booking.plcAmount.gt(0)],
    ["Other charges", booking.otherChargesAmount, booking.otherChargesAmount.gt(0)],
    ["Discount", booking.discountAmount, booking.discountAmount.gt(0)],
    ["GST", booking.gstAmount, booking.gstAmount.gt(0)],
    ["Stamp duty", booking.stampDutyAmount, booking.stampDutyAmount.gt(0)],
    ["Registration", booking.registrationAmount, booking.registrationAmount.gt(0)],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{booking.bookingNumber}</h1>
        <p className="text-sm text-muted-foreground">
          {project?.name} ({project?.code}) · Plot {unit?.unitNumber} · {customer?.name} ·{" "}
          <StatusBadge status={booking.status} tone={bookingStatusTone(booking.status)} />
        </p>
        {customer ? (
          <p className="text-sm text-muted-foreground">
            {customer.phone}
            {customer.email ? ` · ${customer.email}` : ""}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {booking.status === "DRAFT" ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for confirmation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              {holdLive && hold
                ? `Held for ${hold.associate.user.name} (${hold.associate.code}) until ${formatDateTime(hold.expiresAt)}. Confirming books the plot and fixes the price below.`
                : "The associate's hold on this plot has lapsed, so it can no longer be confirmed. They need to book it again."}
            </p>
            {canConfirm ? (
              <form action={confirmBookingAction}>
                <input type="hidden" name="bookingId" value={booking.id} />
                <ConfirmSubmitButton
                  size="sm"
                  disabled={!holdLive}
                  message={`Confirm booking ${booking.bookingNumber}? The plot is booked and the price is fixed.`}
                >
                  Confirm booking
                </ConfirmSubmitButton>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Price</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="flex flex-col divide-y divide-border text-sm">
            {priceRows
              .filter(([, , show]) => show)
              .map(([label, amount]) => (
                <div key={label} className="flex justify-between py-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{formatMoney(amount)}</dd>
                </div>
              ))}
            <div className="flex justify-between py-1.5 font-medium">
              <dt>Agreement value</dt>
              <dd className="tabular-nums">{formatMoney(booking.agreementValue)}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {[
              formatArea(booking.saleableAreaAtBooking, "saleable", basis),
              formatArea(booking.carpetAreaAtBooking, "carpet", basis),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {booking.status === "DRAFT" ? (
            <p className="text-xs text-muted-foreground">
              A draft&rsquo;s price is a preview. It is worked out again, from the price list as it stands, when the booking is
              confirmed.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {booking.costSheetLines.length > 0 ? (
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
          </CardContent>
        </Card>
      ) : null}

      {canCancel ? (
        <Card>
          <CardHeader>
            <CardTitle>Cancel this booking</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={cancelBookingAction} className="flex flex-col gap-2">
              <input type="hidden" name="bookingId" value={booking.id} />
              <textarea
                name="reason"
                placeholder="Cancellation reason (required)"
                required
                rows={2}
                className={FIELD_CLASS}
              />
              <ConfirmSubmitButton
                size="sm"
                variant="destructive"
                className="self-start"
                message={`Cancel booking ${booking.bookingNumber}? The plot goes back on sale.`}
              >
                Cancel booking
              </ConfirmSubmitButton>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">Booked on {formatDate(booking.bookingDate)}</p>
    </div>
  );
}
