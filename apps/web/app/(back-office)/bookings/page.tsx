import type { Metadata } from "next";
import Link from "next/link";
import type { BookingStatus } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listBookings } from "@desire/services/bookings";
import { getSessionPermissions } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bookings — Desire",
};

const STATUSES: BookingStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "AGREEMENT_SIGNED",
  "REGISTERED",
  "POSSESSION_GIVEN",
  "CANCELLED",
];

/** List, scoped exactly as listBookings resolves booking.read (ASSOCIATE own,
 *  TEAM_LEAD own+downline, everyone else with the permission sees the whole
 *  org) -- backend ready per the plan except this list itself, which was a
 *  confirmed gap closed in bookings.ts this slice. */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireSession();
  const db = getPrismaClient();
  const { status } = await searchParams;
  const selectedStatus = STATUSES.includes(status as BookingStatus) ? (status as BookingStatus) : undefined;

  const [bookings, permissions] = await Promise.all([
    listBookings(db, { orgId: session.user.orgId, actorId: session.user.id, status: selectedStatus }),
    getSessionPermissions(db, session.user.id),
  ]);

  const projectIds = [...new Set(bookings.map((b) => b.projectId))];
  const unitIds = [...new Set(bookings.map((b) => b.unitId))];
  const customerIds = [...new Set(bookings.map((b) => b.customerId))];

  const [projects, units, customers] = await Promise.all([
    projectIds.length ? db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }) : [],
    unitIds.length ? db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNumber: true } }) : [],
    customerIds.length ? db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }) : [],
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const customerById = new Map(customers.map((c) => [c.id, c]));

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Bookings</h1>
        {permissions.has("discount.approve") ? (
          <Link href="/bookings/discount-approvals" className="text-sm text-primary hover:underline">
            Discount approvals
          </Link>
        ) : null}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Link
          href="/bookings"
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            !selectedStatus ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
          }`}
        >
          All
        </Link>
        {STATUSES.map((statusOption) => (
          <Link
            key={statusOption}
            href={`/bookings?status=${statusOption}`}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
              selectedStatus === statusOption
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {statusOption}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {bookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bookings.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Booking #</th>
                  <th className="py-1.5 pr-4">Project</th>
                  <th className="py-1.5 pr-4">Unit</th>
                  <th className="py-1.5 pr-4">Customer</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4 text-right">Agreement value</th>
                  <th className="py-1.5 pr-4">Booked on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td className="py-1.5 pr-4">
                      <Link href={`/bookings/${booking.id}`} className="font-medium hover:underline">
                        {booking.bookingNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{projectById.get(booking.projectId)?.name ?? "—"}</td>
                    <td className="py-1.5 pr-4">{unitById.get(booking.unitId)?.unitNumber ?? "—"}</td>
                    <td className="py-1.5 pr-4">{customerById.get(booking.customerId)?.name ?? "—"}</td>
                    <td className="py-1.5 pr-4">{booking.status}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(booking.agreementValue)}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDate(booking.bookingDate)}</td>
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
