import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileBarChart } from "lucide-react";
import type { BookingStatus } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "@desire/services/rbac";
import {
  SalesReportError,
  getSalesByAssociate,
  listAssociateBookings,
  type SalesByAssociate,
} from "@desire/services/sales-report";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { bookingStatusTone } from "@/lib/status-tone";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sales report — Desire",
};

const STATUSES: BookingStatus[] = ["CONFIRMED", "DRAFT", "CANCELLED"];

/** How much each associate has sold. An admin sees every associate; an associate
 *  sees only their own row (the service decides from the signed-in user, not from
 *  anything in the address). Filters are a plain GET form, so a filtered view is a
 *  link that can be shared and a file download carries the same filters. */
export default async function SalesByAssociatePage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; from?: string; to?: string; associate?: string; status?: string }>;
}) {
  const query = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();
  const actor = { orgId: session.user.orgId, actorId: session.user.id };
  const filter = {
    projectId: query.projectId || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
  };
  const status = STATUSES.find((value) => value === query.status);

  let summary: SalesByAssociate | null = null;
  let problem: string | null = null;
  try {
    summary = await getSalesByAssociate(db, { ...actor, ...filter });
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    if (error instanceof SalesReportError) problem = error.message;
    else throw error;
  }

  const projects = await db.project.findMany({
    where: { orgId: session.user.orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const selected = summary?.rows.find((row) => row.associateId === query.associate) ?? null;
  const drill = selected
    ? await listAssociateBookings(db, { ...actor, ...filter, associateId: selected.associateId, status })
    : null;

  // The same filters, carried into the download links and the drill-down links.
  const carried = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) carried.set(key, value);
  const withParams = (extra: Record<string, string>) => {
    const next = new URLSearchParams(carried);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return next.toString();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Sales report</h1>
        <p className="text-sm text-muted-foreground">
          {summary?.scope === "own"
            ? "Your sales. A plot counts as sold once an admin has confirmed the booking."
            : "Plots sold by each associate. A plot counts as sold once an admin has confirmed the booking."}
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          Project
          <select
            name="projectId"
            defaultValue={filter.projectId ?? ""}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          From
          <Input type="date" name="from" defaultValue={filter.from ?? ""} className="w-40" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          To
          <Input type="date" name="to" defaultValue={filter.to ?? ""} className="w-40" />
        </label>
        <Button type="submit" size="sm">
          Show
        </Button>
        <Button nativeButton={false} size="sm" variant="ghost" render={<Link href="/bookings/by-associate" />}>
          Clear
        </Button>
      </form>

      {problem ? (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      ) : null}

      {summary ? (
        <Card>
          <CardContent className="flex flex-col gap-3 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Base price is what the plot was priced at; agreement value is what the customer signs for,
                with the corner premium and other charges.
              </p>
              <div className="flex gap-2">
                <Button
                  nativeButton={false}
                  size="xs"
                  variant="outline"
                  render={<a href={`/api/v1/bookings/by-associate?${withParams({ format: "csv" })}`} download />}
                >
                  CSV
                </Button>
                <Button
                  nativeButton={false}
                  size="xs"
                  variant="outline"
                  render={<a href={`/api/v1/bookings/by-associate?${withParams({ format: "xlsx" })}`} download />}
                >
                  Excel
                </Button>
              </div>
            </div>

            {summary.rows.length === 0 ? (
              <EmptyState icon={FileBarChart} message="No bookings in this period." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-4">Associate</th>
                    <th className="py-1.5 pr-4 text-right">Sold</th>
                    <th className="py-1.5 pr-4 text-right">Waiting</th>
                    <th className="py-1.5 pr-4 text-right">Cancelled</th>
                    <th className="py-1.5 pr-4 text-right">Base price</th>
                    <th className="py-1.5 pr-4 text-right">Agreement value</th>
                    <th className="py-1.5 pr-4 text-right">Average</th>
                    <th className="py-1.5 pr-4">Last sale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.rows.map((row) => (
                    <tr key={row.associateId} className={row.associateId === selected?.associateId ? "bg-muted/50" : ""}>
                      <td className="py-1.5 pr-4">
                        <Link
                          href={`/bookings/by-associate?${withParams({ associate: row.associateId })}`}
                          className="font-medium hover:underline"
                        >
                          {row.name}
                        </Link>{" "}
                        <span className="text-xs text-muted-foreground">{row.code}</span>
                      </td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{row.sold}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{row.waiting}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{row.cancelled}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(row.baseTotal)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(row.agreementTotal)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{row.average ? formatMoney(row.average) : "—"}</td>
                      <td className="py-1.5 pr-4">{row.lastSale ? formatDate(row.lastSale) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="py-1.5 pr-4">Total</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{summary.totals.sold}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{summary.totals.waiting}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{summary.totals.cancelled}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(summary.totals.baseTotal)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(summary.totals.agreementTotal)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {summary.totals.average ? formatMoney(summary.totals.average) : "—"}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {selected && drill ? (
        <Card>
          <CardContent className="flex flex-col gap-3 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {selected.name} <span className="font-normal text-muted-foreground">({selected.code})</span>
              </h2>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/bookings/by-associate?${withParams({ associate: selected.associateId })}`}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${!status ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}
                >
                  All
                </Link>
                {STATUSES.map((option) => (
                  <Link
                    key={option}
                    href={`/bookings/by-associate?${withParams({ associate: selected.associateId, status: option })}`}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${status === option ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}
                  >
                    {option}
                  </Link>
                ))}
                <Button
                  nativeButton={false}
                  size="xs"
                  variant="outline"
                  render={
                    <a
                      href={`/api/v1/bookings/by-associate?${withParams({ view: "bookings", associate: selected.associateId, ...(status ? { status } : {}), format: "csv" })}`}
                      download
                    />
                  }
                >
                  CSV
                </Button>
              </div>
            </div>
            {drill.rows.length === 0 ? (
              <EmptyState icon={FileBarChart} message="No bookings." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-4">Booking</th>
                    <th className="py-1.5 pr-4">Date</th>
                    <th className="py-1.5 pr-4">Project · plot</th>
                    <th className="py-1.5 pr-4">Customer</th>
                    <th className="py-1.5 pr-4">Status</th>
                    <th className="py-1.5 pr-4 text-right">Base price</th>
                    <th className="py-1.5 pr-4 text-right">Agreement value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {drill.rows.map((row) => (
                    <tr key={row.bookingId}>
                      <td className="py-1.5 pr-4">
                        <Link href={`/bookings/${row.bookingId}`} className="font-medium hover:underline">
                          {row.bookingNumber}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-4">{formatDate(row.bookingDate)}</td>
                      <td className="py-1.5 pr-4">
                        {row.projectName} · {row.unitNumber}
                      </td>
                      <td className="py-1.5 pr-4">{row.customerName}</td>
                      <td className="py-1.5 pr-4">
                        <StatusBadge status={row.status} tone={bookingStatusTone(row.status)} />
                      </td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(row.baseAmount)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(row.agreementValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {drill.truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing the newest {drill.rows.length}. Narrow the dates, or download the file, to see the rest.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
