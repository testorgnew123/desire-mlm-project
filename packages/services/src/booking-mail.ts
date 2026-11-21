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

/** Once the mail is handed to `after()` nobody is waiting on it, so the mail
 *  server gets as long as it needs instead of the message being dropped. A far
 *  mail server needs about ten round trips to connect, start TLS, log in and
 *  send: enough on a fast link, not enough on a slow one. That is the difference
 *  between booking mail going missing and the admin screen's test mail, which
 *  allows 15 s, always arriving. */
export const BOOKING_MAIL_AFTER_RESPONSE_DEADLINE_MS = 20_000;

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
  // One statement, not six: the booking and the four rows its mail quotes are
  // joined in the database. This runs inside the request of the person who
  // confirmed or booked, after the commit, and each statement is a round trip.
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    relationLoadStrategy: "join",
    select: {
      id: true,
      orgId: true,
      bookingNumber: true,
      status: true,
      agreementValue: true,
      cancellationReason: true,
      unit: { select: { unitNumber: true } },
      project: { select: { name: true } },
      customer: { select: { name: true, email: true } },
      sellingAssociate: { select: { user: { select: { name: true, email: true } } } },
    },
  });
  if (!booking) return null;
  return {
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    agreementValue: booking.agreementValue,
    unitNumber: booking.unit.unitNumber,
    projectName: booking.project.name,
    customerName: booking.customer.name,
    customerEmail: booking.customer.email,
    associateName: booking.sellingAssociate.user.name,
    associateEmail: booking.sellingAssociate.user.email,
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

/** The buyer's first mail, as soon as the booking exists: it says the booking is
 *  in hand and being processed, and nothing more. No price, because an admin has
 *  not agreed it yet, and no link, because a buyer has no account to open. */
export function customerBookingReceivedMailText(facts: BookingFacts): string {
  return [
    `Dear ${facts.customerName},`,
    "",
    "We have your booking and it is being processed.",
    "",
    `Booking number: ${facts.bookingNumber}`,
    plotLine(facts),
    "",
    `Your contact for this booking is ${facts.associateName}.`,
    "You will get another email from us once the booking is confirmed.",
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

// `deadlineMs` comes from the caller, not from whether a scheduler is
// registered: a registered scheduler that refuses the work still leaves a person
// waiting, and they must not be held for the long deadline.
async function sendAll(
  what: string,
  bookingNumber: string,
  deadlineMs: number,
  messages: Array<{ to: string; subject: string; text: string }>,
): Promise<void> {
  if (messages.length === 0) return;
  const outcomes = await Promise.all(
    messages.map(async (message) => {
      const startedAt = Date.now();
      const outcome = await sendMail(message, deadlineMs);
      return { ...outcome, ms: Date.now() - startedAt };
    }),
  );

  // A booking mail that does not go out leaves no trace otherwise: nothing
  // throws, the booking is already made and nobody sees an error. Says how many
  // and why, never an address.
  const failed = outcomes.filter((outcome) => !outcome.sent);
  if (failed.length > 0) {
    const slowest = Math.max(...failed.map((outcome) => outcome.ms));
    console.error(
      `booking mail (${what}) for ${bookingNumber}: ${failed.length} of ${outcomes.length} not sent after ${slowest} ms of ${deadlineMs} ms -- ${failed[0]!.note ?? "no reason given"}`,
    );
  }
}

/** Runs a piece of work once the response has gone (Next's `after()`). */
export type MailScheduler = (task: () => Promise<void>) => void;

// On globalThis, not in a module variable: the host registers the scheduler from
// instrumentation.ts, which is bundled apart from the route handlers, and both
// must see the same one.
const globals = globalThis as unknown as { __desireBookingMailScheduler?: MailScheduler };

/** By default the person who books or confirms waits for the mail (at most
 *  BOOKING_MAIL_DEADLINE_MS): on a serverless function nothing is guaranteed to
 *  run once the response has gone, so waiting is the one way to be sure the mail
 *  reached the server. A host that can keep a function alive after the response
 *  registers a scheduler here and nobody waits for the mail server any more
 *  (BOOKING_MAIL_AFTER_RESPONSE in apps/web/instrumentation.ts, off by default). */
export function setBookingMailScheduler(scheduler: MailScheduler | null): void {
  globals.__desireBookingMailScheduler = scheduler ?? undefined;
}

// The task is told how long the mail server may take, which depends on who is
// waiting for it: nobody, once the response has gone, or the person who booked.
async function deliver(task: (deadlineMs: number) => Promise<void>): Promise<void> {
  const scheduler = globals.__desireBookingMailScheduler;
  if (scheduler) {
    try {
      scheduler(() => task(BOOKING_MAIL_AFTER_RESPONSE_DEADLINE_MS));
      return;
    } catch {
      // Not inside a request (a script, a job): there is no response to come after,
      // so send it here and now.
    }
  }
  await task(BOOKING_MAIL_DEADLINE_MS);
}

/** Runs one notification and swallows anything it throws: a mail problem must not
 *  turn a finished booking into an error. Logs the booking id, never an address. */
async function safely(what: string, bookingId: string, run: (deadlineMs: number) => Promise<void>): Promise<void> {
  if (!isMailConfigured()) return;
  await deliver(async (deadlineMs) => {
    try {
      await run(deadlineMs);
    } catch (error) {
      console.error(`booking mail (${what}) failed for ${bookingId}`, error instanceof Error ? error.name : error);
    }
  });
}

/** A new booking (a draft) is waiting: tell every admin who may confirm it,
 *  except the person who made it, and tell the buyer that it is being
 *  processed. */
export async function notifyBookingDrafted(db: PrismaClient, params: { bookingId: string; actorId: string | null }): Promise<void> {
  await safely("drafted", params.bookingId, async (deadlineMs) => {
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
    // The staff mail says what a plot sold for and links into the back office,
    // so the buyer must never receive it -- not even when the address they gave
    // is also a staff login, which is how a buyer once got it.
    const buyerEmail = facts.customerEmail?.trim().toLowerCase() ?? null;
    const messages = admins
      .filter((admin) => admin.email.trim().toLowerCase() !== buyerEmail)
      .map((admin) => ({ to: admin.email, subject: `Booking ${facts.bookingNumber} needs confirming`, text }));

    if (facts.customerEmail) {
      messages.push({
        to: facts.customerEmail,
        subject: `Your booking ${facts.bookingNumber} has been received`,
        text: customerBookingReceivedMailText(facts),
      });
    }
    await sendAll("drafted", facts.bookingNumber, deadlineMs, messages);
  });
}

/** A booking was confirmed: the customer (when an email was entered) and the
 *  selling associate. */
export async function notifyBookingConfirmed(db: PrismaClient, params: { bookingId: string }): Promise<void> {
  await safely("confirmed", params.bookingId, async (deadlineMs) => {
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
    await sendAll("confirmed", facts.bookingNumber, deadlineMs, messages);
  });
}

/** A booking was cancelled: the selling associate. (The customer is not told by
 *  email: a cancellation is a conversation first.) */
export async function notifyBookingCancelled(db: PrismaClient, params: { bookingId: string }): Promise<void> {
  await safely("cancelled", params.bookingId, async (deadlineMs) => {
    const facts = await loadFacts(db, params.bookingId);
    if (!facts) return;
    await sendAll("cancelled", facts.bookingNumber, deadlineMs, [
      { to: facts.associateEmail, subject: `Booking ${facts.bookingNumber} cancelled`, text: associateCancelledMailText(facts) },
    ]);
  });
}
