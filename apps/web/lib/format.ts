// Shared display formatters: dates and the hold countdown. Deliberately free
// of any @desire/db import -- this module is reached from CLIENT components
// too (board's InventoryBoard.tsx, via board/format.ts's re-export), and
// pulling in Prisma here would drag pg/net/tls into the browser bundle.
// Money and area formatting need Prisma.Decimal and therefore live in
// lib/money.ts instead, imported only from Server Components.

/** Indian digit grouping (docs/08-SCREENS.md): last three digits, then pairs.
 *  1234567 -> "12,34,567". Moved here from board/format.ts, the one other
 *  place this logic existed, so both implementations share it. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`;
}

// Asia/Kolkata is pinned rather than left to the device -- business dates are
// IST (docs/12-NFR.md) and a phone with the wrong timezone must not shift a
// date the associate is reading off the screen.
const IST_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** DD-MMM-YYYY. `03-09-2026` is ambiguous across the team, so the month is
 *  always spelled (docs/08-SCREENS.md). */
export function formatDate(value: string | Date): string {
  const at = typeof value === "string" ? new Date(value) : value;
  // en-GB gives "07 Sep 2026"; the separator is the only thing that changes.
  return IST_DATE.format(at).replace(/\s+/g, "-");
}

// hourCycle rather than hour12:false -- some ICU builds render midnight as
// "24:00" under hour12:false.
const IST_HOUR_MINUTE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** DD-MMM-YYYY HH:mm. Originally board-only (formatIstDateTime); moved here
 *  so the login flow's account-lockout message shares the exact same
 *  rendering rather than a second copy. */
export function formatDateTime(value: string | Date): string {
  const at = typeof value === "string" ? new Date(value) : value;
  return `${formatDate(at)} ${IST_HOUR_MINUTE.format(at)}`;
}

/** mm:ss, widening to h:mm:ss once an hour or more remains. Countdown to a
 *  hold's expiry -- the one number on the inventory screens an associate
 *  actually acts on (originally board-only; moved here so the PWA inventory
 *  tab in Slice 3 shares the exact same function instead of a second copy).
 *
 *  The default hold TTL is 1440 minutes (Project.holdTtlMinutes,
 *  docs/06-INVENTORY-SPEC.md section 4) and "1439:12" is not a number anyone
 *  reads at a glance on a phone in sunlight. Under an hour -- the hour in
 *  which a hold actually gets acted on -- it is plain mm:ss. */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mmss = `${pad2(minutes)}:${pad2(seconds)}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
