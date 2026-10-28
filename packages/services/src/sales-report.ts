// Sales by associate: how much each associate has sold, in plots and in rupees.
//
// "Sold" means a booking an admin has confirmed or that has moved on from there
// (CONFIRMED, AGREEMENT_SIGNED, REGISTERED, POSSESSION_GIVEN). Drafts are shown
// beside it as "waiting" so the report explains the gap, and cancelled ones are
// counted but never summed. Both the base price and the agreement value are
// shown: the base is what the plot was priced at, the agreement value is what the
// customer signs for (with the corner premium and the other charges).
//
// Who sees what is decided here from the actor, never from a parameter: an admin
// sees every associate, an associate only their own row (resolveBookingScope).
import { Prisma } from "@desire/db";
import type { BookingStatus, PrismaClient } from "@desire/db";
import { resolveBookingScope } from "./bookings";
import { guardFormula, type ReportColumn } from "./export";
import { ForbiddenError } from "./rbac";

export const SOLD_STATUSES: readonly BookingStatus[] = ["CONFIRMED", "AGREEMENT_SIGNED", "REGISTERED", "POSSESSION_GIVEN"];
const WAITING_STATUSES: readonly BookingStatus[] = ["DRAFT", "PENDING_APPROVAL"];

/** Most bookings one drill-down returns. */
export const DRILLDOWN_LIMIT = 200;

export class SalesReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesReportError";
  }
}

export interface SalesFilter {
  projectId?: string;
  /** YYYY-MM-DD, an Indian calendar day, inclusive. */
  from?: string;
  to?: string;
}

/** `from`/`to` as the half-open range [start, end) of instants. Days are Indian
 *  days (UTC+05:30, no daylight saving): a booking made at 11:50 pm on the 31st
 *  belongs to the 31st, not to the 1st the UTC clock has already reached. */
export function istDayRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const range: { gte?: Date; lt?: Date } = {};
  if (from) range.gte = istMidnight(from, 0);
  if (to) range.lt = istMidnight(to, 1);
  if (range.gte && range.lt && range.gte >= range.lt) {
    throw new SalesReportError("The end date is before the start date.");
  }
  return range;
}

function istMidnight(day: string, plusDays: number): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new SalesReportError(`"${day}" is not a date (use YYYY-MM-DD).`);
  const start = new Date(`${day}T00:00:00+05:30`);
  // Rejects 2026-02-31, which Date would roll into March, and 2026-13-01.
  const check = Number.isNaN(start.getTime())
    ? ""
    : new Date(start.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  if (check !== day) throw new SalesReportError(`"${day}" is not a date.`);
  return new Date(start.getTime() + plusDays * 86_400_000);
}

export interface AssociateSales {
  associateId: string;
  code: string;
  name: string;
  sold: number;
  waiting: number;
  cancelled: number;
  /** Fixed-point rupees, two decimals. */
  baseTotal: string;
  agreementTotal: string;
  /** agreementTotal / sold, or null with no sales. */
  average: string | null;
  lastSale: Date | null;
}

export interface SalesByAssociate {
  rows: AssociateSales[];
  totals: Omit<AssociateSales, "associateId" | "code" | "name" | "lastSale" | "average"> & { average: string | null };
  /** "all" for an admin, "own" for an associate (own row and, for a team lead, their team). */
  scope: "all" | "own";
}

const money = (value: Prisma.Decimal): string => value.toFixed(2);

function whereFor(orgId: string, filter: SalesFilter, associateIds: string[] | null): Prisma.BookingWhereInput {
  const bookingDate = istDayRange(filter.from, filter.to);
  return {
    orgId,
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(bookingDate.gte || bookingDate.lt ? { bookingDate } : {}),
    ...(associateIds ? { sellingAssociateId: { in: associateIds } } : {}),
  };
}

/** One grouped read of bookings by associate and status, plus one read of the
 *  associates' names: the number of statements does not grow with the number of
 *  associates. */
export async function getSalesByAssociate(
  db: PrismaClient,
  params: { orgId: string; actorId: string } & SalesFilter,
): Promise<SalesByAssociate> {
  const scope = await resolveBookingScope(db, { actorId: params.actorId, projectId: params.projectId });
  const grouped = await db.booking.groupBy({
    by: ["sellingAssociateId", "status"],
    where: whereFor(params.orgId, params, scope),
    _count: { _all: true },
    _sum: { baseAmount: true, agreementValue: true },
    _max: { confirmedAt: true },
  });

  const byAssociate = new Map<string, AssociateSales & { base: Prisma.Decimal; agreement: Prisma.Decimal }>();
  const blank = (associateId: string) => ({
    associateId,
    code: "",
    name: "",
    sold: 0,
    waiting: 0,
    cancelled: 0,
    baseTotal: "0.00",
    agreementTotal: "0.00",
    average: null,
    lastSale: null,
    base: new Prisma.Decimal(0),
    agreement: new Prisma.Decimal(0),
  });
  // An associate sees their own row even with nothing sold yet.
  for (const id of scope ?? []) byAssociate.set(id, blank(id));

  for (const row of grouped) {
    const entry = byAssociate.get(row.sellingAssociateId) ?? blank(row.sellingAssociateId);
    byAssociate.set(row.sellingAssociateId, entry);
    const count = row._count._all;
    if (SOLD_STATUSES.includes(row.status)) {
      entry.sold += count;
      entry.base = entry.base.plus(row._sum.baseAmount ?? 0);
      entry.agreement = entry.agreement.plus(row._sum.agreementValue ?? 0);
      const confirmed = row._max.confirmedAt;
      if (confirmed && (!entry.lastSale || confirmed > entry.lastSale)) entry.lastSale = confirmed;
    } else if (WAITING_STATUSES.includes(row.status)) {
      entry.waiting += count;
    } else if (row.status === "CANCELLED") {
      entry.cancelled += count;
    }
  }

  const ids = [...byAssociate.keys()];
  const people = ids.length
    ? await db.associate.findMany({
        where: { id: { in: ids }, orgId: params.orgId },
        select: { id: true, code: true, user: { select: { name: true } } },
      })
    : [];
  const personById = new Map(people.map((p) => [p.id, p]));

  let sold = 0;
  let waiting = 0;
  let cancelled = 0;
  let base = new Prisma.Decimal(0);
  let agreement = new Prisma.Decimal(0);
  const rows: AssociateSales[] = [];
  for (const entry of byAssociate.values()) {
    const person = personById.get(entry.associateId);
    // Bookings of an associate outside this organisation cannot be, but a row
    // with no person would be unreadable: leave it out of rows and totals alike.
    if (!person) continue;
    sold += entry.sold;
    waiting += entry.waiting;
    cancelled += entry.cancelled;
    base = base.plus(entry.base);
    agreement = agreement.plus(entry.agreement);
    rows.push({
      associateId: entry.associateId,
      code: person.code,
      name: person.user.name,
      sold: entry.sold,
      waiting: entry.waiting,
      cancelled: entry.cancelled,
      baseTotal: money(entry.base),
      agreementTotal: money(entry.agreement),
      average: entry.sold > 0 ? money(entry.agreement.div(entry.sold)) : null,
      lastSale: entry.lastSale,
    });
  }
  // Most sold first; ties by agreement value, then code, so the order is stable.
  rows.sort(
    (a, b) =>
      b.sold - a.sold || Number(b.agreementTotal) - Number(a.agreementTotal) || a.code.localeCompare(b.code),
  );

  return {
    rows,
    totals: {
      sold,
      waiting,
      cancelled,
      baseTotal: money(base),
      agreementTotal: money(agreement),
      average: sold > 0 ? money(agreement.div(sold)) : null,
    },
    scope: scope === null ? "all" : "own",
  };
}

export interface AssociateBookingRow {
  bookingId: string;
  bookingNumber: string;
  bookingDate: Date;
  status: BookingStatus;
  projectName: string;
  unitNumber: string;
  customerName: string;
  baseAmount: string;
  agreementValue: string;
}

/** The bookings behind one associate's row, newest first. Refused (empty) for an
 *  associate outside the caller's scope, so the id in the URL grants nothing. */
export async function listAssociateBookings(
  db: PrismaClient,
  params: { orgId: string; actorId: string; associateId: string; status?: BookingStatus; take?: number } & SalesFilter,
): Promise<{ rows: AssociateBookingRow[]; truncated: boolean }> {
  const scope = await resolveBookingScope(db, { actorId: params.actorId, projectId: params.projectId });
  if (scope && !scope.includes(params.associateId)) throw new ForbiddenError("That associate's sales are not visible to you.");

  const take = Math.min(params.take ?? DRILLDOWN_LIMIT, DRILLDOWN_LIMIT);
  const where: Prisma.BookingWhereInput = {
    ...whereFor(params.orgId, params, null),
    sellingAssociateId: params.associateId,
    ...(params.status ? { status: params.status } : {}),
  };
  const bookings = await db.booking.findMany({ where, orderBy: { bookingDate: "desc" }, take: take + 1 });
  const truncated = bookings.length > take;
  const shown = bookings.slice(0, take);

  const [projects, units, customers] = await Promise.all([
    db.project.findMany({ where: { id: { in: [...new Set(shown.map((b) => b.projectId))] } }, select: { id: true, name: true } }),
    db.unit.findMany({ where: { id: { in: [...new Set(shown.map((b) => b.unitId))] } }, select: { id: true, unitNumber: true } }),
    db.customer.findMany({ where: { id: { in: [...new Set(shown.map((b) => b.customerId))] } }, select: { id: true, name: true } }),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const unitNumber = new Map(units.map((u) => [u.id, u.unitNumber]));
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  return {
    truncated,
    rows: shown.map((b) => ({
      bookingId: b.id,
      bookingNumber: b.bookingNumber,
      bookingDate: b.bookingDate,
      status: b.status,
      projectName: projectName.get(b.projectId) ?? "",
      unitNumber: unitNumber.get(b.unitId) ?? "",
      customerName: customerName.get(b.customerId) ?? "",
      baseAmount: money(b.baseAmount),
      agreementValue: money(b.agreementValue),
    })),
  };
}

// ── Export shape ───────────────────────────────────────────────────────

const SUMMARY_COLUMNS: ReportColumn[] = [
  { key: "code", label: "Associate code" },
  { key: "name", label: "Associate" },
  { key: "sold", label: "Plots sold" },
  { key: "waiting", label: "Waiting for confirmation" },
  { key: "cancelled", label: "Cancelled" },
  { key: "baseTotal", label: "Base price total (INR)" },
  { key: "agreementTotal", label: "Agreement value total (INR)" },
  { key: "average", label: "Average agreement value (INR)" },
  { key: "lastSale", label: "Last sale confirmed" },
];

const isoDate = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : "");

/** The summary as report rows (strings, as the shared CSV and XLSX writers
 *  take), totals last. Free text is guarded against spreadsheet formulas. */
export function summaryToReport(result: SalesByAssociate): { columns: ReportColumn[]; rows: string[][] } {
  const rows = result.rows.map((r) => [
    guardFormula(r.code),
    guardFormula(r.name),
    String(r.sold),
    String(r.waiting),
    String(r.cancelled),
    r.baseTotal,
    r.agreementTotal,
    r.average ?? "",
    isoDate(r.lastSale),
  ]);
  const t = result.totals;
  rows.push(["", "Total", String(t.sold), String(t.waiting), String(t.cancelled), t.baseTotal, t.agreementTotal, t.average ?? "", ""]);
  return { columns: SUMMARY_COLUMNS, rows };
}

const BOOKING_COLUMNS: ReportColumn[] = [
  { key: "bookingNumber", label: "Booking" },
  { key: "bookingDate", label: "Booking date" },
  { key: "status", label: "Status" },
  { key: "project", label: "Project" },
  { key: "plot", label: "Plot" },
  { key: "customer", label: "Customer" },
  { key: "baseAmount", label: "Base price (INR)" },
  { key: "agreementValue", label: "Agreement value (INR)" },
];

export function bookingsToReport(rows: AssociateBookingRow[]): { columns: ReportColumn[]; rows: string[][] } {
  return {
    columns: BOOKING_COLUMNS,
    rows: rows.map((r) => [
      guardFormula(r.bookingNumber),
      isoDate(r.bookingDate),
      r.status,
      guardFormula(r.projectName),
      guardFormula(r.unitNumber),
      guardFormula(r.customerName),
      r.baseAmount,
      r.agreementValue,
    ]),
  };
}
