import type { Metadata } from "next";
import { ClipboardList, CircleCheck } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { listBookings } from "@desire/services/bookings";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { bookingStatusTone } from "@/lib/status-tone";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My bookings — Desire",
};

/** The associate's own bookings, newest drafts first. listBookings scopes an
 *  associate to their own, so nothing here filters by hand. Capped, because an
 *  associate who sells for years should not load every booking they ever made
 *  to look at this week's. */
export default async function MyBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ booked?: string }>;
}) {
  const { booked } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const bookings = await listBookings(db, {
    orgId: session.user.orgId,
    actorId: session.user.id,
    draftsFirst: true,
    take: 50,
  });

  const unitIds = [...new Set(bookings.map((b) => b.unitId))];
  const customerIds = [...new Set(bookings.map((b) => b.customerId))];
  const [units, customers] = await Promise.all([
    unitIds.length
      ? db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNumber: true } })
      : [],
    customerIds.length
      ? db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const unitNumber = new Map(units.map((u) => [u.id, u.unitNumber]));
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">My bookings</h1>

      {booked ? (
        <p role="status" className="flex items-start gap-1.5 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          Booking {booked} created. It is waiting for an admin to confirm it.
        </p>
      ) : null}

      {bookings.length === 0 ? (
        <EmptyState icon={ClipboardList} message="No bookings yet. Pick a plot in Inventory and tap Book." />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {bookings.map((booking) => (
            <li key={booking.id} className="flex flex-col gap-1 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {booking.bookingNumber} · Plot {unitNumber.get(booking.unitId) ?? "—"}
                </span>
                <StatusBadge status={booking.status} tone={bookingStatusTone(booking.status)} />
              </div>
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span>{customerName.get(booking.customerId) ?? "—"}</span>
                <span className="tabular-nums">{formatMoney(booking.agreementValue)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {booking.status === "DRAFT"
                  ? "Waiting for an admin to confirm. The plot stays held for you until then."
                  : `Booked on ${formatDate(booking.bookingDate)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
