// Emails about a booking: the admins who must confirm it, the customer and the
// selling associate once it is confirmed, the associate when it is cancelled.
//
// Best-effort, like the account mail (account-mail.ts): the booking has already
// happened when these go out, so nothing here ever throws or changes the answer
// the caller gets. A mail server that is down, slow or not configured costs the
// recipient an email and nobody an error. With no SMTP settings the functions
// return before they read anything, so an unconfigured server pays nothing.
//
// Kept apart from admin.ts and password-reset.ts on purpose: no password hasher
// here, so bookings.ts can import it without dragging a native addon along.
import type { PrismaClient } from "@desire/db";
import { appBaseUrl, sendMail } from "./account-mail";
import { isMailConfigured } from "./email";

/** All the mails of one event are sent together and this long is all they get:
 *  the caller is a person waiting on a confirm or a booking. */
export const BOOKING_MAIL_DEADLINE_MS = 4_000;

/** At most this many admins are told about one new booking. */
const MAX_ADMIN_RECIPIENTS = 20;

/** Indian grouping, two decimals, from the Decimal's own text so a large value is
 *  never rounded through a float: 5200000 -> "₹52,00,000.00". */
export function formatRupees(value: { toFixed(places: number): string }): string {
  const [whole = "0", fraction = "00"] = value.toFixed(2).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}` : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${fraction}`;
}

interface BookingFacts {
  id: string;
  bookingNumber: string;
  status: string;
  agreementValue: { toFixed(places: number): string };
  unitNumber: string;
  projectName: string;
  customerName: string;
  customerEmail: string | null;
  associateName: string;
  associateEmail: string;
  orgId: string;
  cancellationReason: string | null;
}

async function loadFacts(db: PrismaClient, bookingId: string): Promise<BookingFacts | null> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      orgId: true,
      bookingNumber: true,
      status: true,
      agreementValue: true,
      cancellationReason: true,
      unitId: true,
      projectId: true,
      customerId: true,
      sellingAssociateId: true,
    },
  });
  if (!booking) return null;
  const [unit, project, customer, associate] = await Promise.all([
    db.unit.findUnique({ where: { id: booking.unitId }, select: { unitNumber: true } }),
    db.project.findUnique({ where: { id: booking.projectId }, select: { name: true } }),
    db.customer.findUnique({ where: { id: booking.customerId }, select: { name: true, email: true } }),
    db.associate.findUnique({ where: { id: booking.sellingAssociateId }, select: { user: { select: { name: true, email: true } } } }),
  ]);
  if (!unit || !project || !customer || !associate) return null;
  return {
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    agreementValue: booking.agreementValue,
    unitNumber: unit.unitNumber,
    projectName: project.name,
    customerName: customer.name,
    customerEmail: customer.email,
    associateName: associate.user.name,
    associateEmail: associate.user.email,
    orgId: booking.orgId,
    cancellationReason: booking.cancellationReason,
  };
}

const plotLine = (facts: BookingFacts) => `Plot ${facts.unitNumber}, ${facts.projectName}`;

// ── Text ───────────────────────────────────────────────────────────────

export function adminBookingMailText(facts: BookingFacts, baseUrl: string | null): string {
  return [
    "A booking is waiting for you to confirm.",
    "",
    `Booking: ${facts.bookingNumber}`,
    plotLine(facts),
    `Customer: ${facts.customerName}`,
    `Booked by: ${facts.associateName}`,
    `Price: ${formatRupees(facts.agreementValue)}`,
    "",
    ...(baseUrl ? [`Open it: ${baseUrl}/bookings/${facts.id}`, ""] : []),
    "The plot stays held for the associate until the hold runs out, so confirm it before then.",
  ].join("\n");
}

export function customerBookingMailText(facts: BookingFacts): string {
  return [
    `Dear ${facts.customerName},`,
    "",
    "Your booking is confirmed.",
    "",
    `Booking number: ${facts.bookingNumber}`,
    plotLine(facts),
    `Price: ${formatRupees(facts.agreementValue)}`,
    "",
    `Your contact for this booking is ${facts.associateName}.`,
    "Please keep this email for your records.",
  ].join("\n");
}

export function associateConfirmedMailText(facts: BookingFacts): string {
  return [
    `Hello ${facts.associateName},`,
    "",
    `Booking ${facts.bookingNumber} has been confirmed.`,
    plotLine(facts),
    `Customer: ${facts.customerName}`,
    `Price: ${formatRupees(facts.agreementValue)}`,
  ].join("\n");
}

export function associateCancelledMailText(facts: BookingFacts): string {
  return [
    `Hello ${facts.associateName},`,
    "",
    `Booking ${facts.bookingNumber} has been cancelled.`,
    plotLine(facts),
    `Customer: ${facts.customerName}`,
    ...(facts.cancellationReason ? ["", `Reason: ${facts.cancellationReason}`] : []),
  ].join("\n");
}

// ── Sending ────────────────────────────────────────────────────────────

async function sendAll(messages: Array<{ to: string; subject: string; text: string }>): Promise<void> {
  if (messages.length === 0) return;
  await Promise.allSettled(messages.map((message) => sendMail(message, BOOKING_MAIL_DEADLINE_MS)));
}

/** Runs one notification and swallows anything it throws: a mail problem must not
 *  turn a finished booking into an error. Logs the booking id, never an address. */
async function safely(what: string, bookingId: string, run: () => Promise<void>): Promise<void> {
  if (!isMailConfigured()) return;
  try {
    await run();
  } catch (error) {
    console.error(`booking mail (${what}) failed for ${bookingId}`, error instanceof Error ? error.name : error);
  }
}

/** A new booking (a draft) is waiting: tell every admin who may confirm it,
 *  except the person who made it. */
export async function notifyBookingDrafted(db: PrismaClient, params: { bookingId: string; actorId: string | null }): Promise<void> {
  await safely("drafted", params.bookingId, async () => {
    const facts = await loadFacts(db, params.bookingId);
    if (!facts) return;
    const admins = await db.user.findMany({
      where: {
        orgId: facts.orgId,
        // INVITED counts: an admin who has not signed in yet can still be told.
        status: { in: ["ACTIVE", "INVITED"] },
        ...(params.actorId ? { id: { not: params.actorId } } : {}),
        userRoles: { some: { role: { rolePermissions: { some: { permission: { code: "booking.confirm" } } } } } },
      },
      select: { email: true },
      orderBy: { email: "asc" },
      take: MAX_ADMIN_RECIPIENTS,
    });
    const text = adminBookingMailText(facts, appBaseUrl());
    await sendAll(admins.map((admin) => ({ to: admin.email, subject: `Booking ${facts.bookingNumber} needs confirming`, text })));
  });
}

/** A booking was confirmed: the customer (when an email was entered) and the
 *  selling associate. */
export async function notifyBookingConfirmed(db: PrismaClient, params: { bookingId: string }): Promise<void> {
  await safely("confirmed", params.bookingId, async () => {
    const facts = await loadFacts(db, params.bookingId);
    if (!facts) return;
    const messages = [
      { to: facts.associateEmail, subject: `Booking ${facts.bookingNumber} confirmed`, text: associateConfirmedMailText(facts) },
    ];
    if (facts.customerEmail) {
      messages.push({
        to: facts.customerEmail,
        subject: `Your booking ${facts.bookingNumber} is confirmed`,
        text: customerBookingMailText(facts),
      });
    }
    await sendAll(messages);
  });
}

/** A booking was cancelled: the selling associate. (The customer is not told by
 *  email: a cancellation is a conversation first.) */
export async function notifyBookingCancelled(db: PrismaClient, params: { bookingId: string }): Promise<void> {
  await safely("cancelled", params.bookingId, async () => {
    const facts = await loadFacts(db, params.bookingId);
    if (!facts) return;
    await sendAll([
      { to: facts.associateEmail, subject: `Booking ${facts.bookingNumber} cancelled`, text: associateCancelledMailText(facts) },
    ]);
  });
}
