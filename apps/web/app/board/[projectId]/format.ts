// Display formatting for the board. One implementation of the countdown,
// because it is the one number on this screen an associate acts on.

/** Expiry notifications fire 30 minutes out (docs/06-INVENTORY-SPEC.md section
 *  4), so that is where the tile starts shouting. */
export const EXPIRY_WARNING_MS = 30 * 60_000;

/** mm:ss, widening to h:mm:ss once an hour or more remains.
 *
 *  The brief asks for mm:ss and that is right for the window that matters, but
 *  the default TTL is 1440 minutes (Project.holdTtlMinutes, docs/06-INVENTORY-SPEC.md
 *  section 4) and "1439:12" is not a number anyone reads at a glance on a phone
 *  in sunlight. Under an hour -- the hour in which a hold actually gets acted
 *  on -- it is plain mm:ss. */
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

// Asia/Kolkata is pinned rather than left to the device. Business dates are IST
// (docs/12-NFR.md) and a phone with the wrong timezone must not shift the
// expiry an associate is reading off the screen. Pinning it also makes these
// deterministic across the server render and the client hydration.
const IST_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

// hourCycle rather than hour12:false -- some ICU builds render midnight as
// "24:00" under hour12:false.
const IST_HOUR_MINUTE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const IST_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** DD-MMM-YYYY HH:mm. `03-09-2026` is ambiguous across the team, so the month
 *  is always spelled (docs/08-SCREENS.md). */
export function formatIstDateTime(iso: string): string {
  const at = new Date(iso);
  // en-GB gives "07 Sep 2026"; the separator is the only thing that changes.
  return `${IST_DATE.format(at).replace(/\s+/g, "-")} ${IST_HOUR_MINUTE.format(at)}`;
}

/** HH:mm:ss. Used for "last refreshed", where seconds are the point. */
export function formatIstClock(iso: string): string {
  return IST_CLOCK.format(new Date(iso));
}
