// Display formatting for the board. formatCountdown and the DD-MMM-YYYY
// (with and without time) rendering now live in apps/web/lib/format.ts --
// shared with the PWA inventory tab (Slice 3) and the login flow rather than
// duplicated -- and are re-exported below so this module's existing import
// sites don't change.
export { formatCountdown, formatDateTime as formatIstDateTime } from "@/lib/format";

/** Expiry notifications fire 30 minutes out (docs/06-INVENTORY-SPEC.md section
 *  4), so that is where the tile starts shouting. */
export const EXPIRY_WARNING_MS = 30 * 60_000;

// Asia/Kolkata is pinned rather than left to the device. Business dates are IST
// (docs/12-NFR.md) and a phone with the wrong timezone must not shift the
// expiry an associate is reading off the screen. Pinning it also makes these
// deterministic across the server render and the client hydration.
//
// hourCycle rather than hour12:false -- some ICU builds render midnight as
// "24:00" under hour12:false.
const IST_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** HH:mm:ss. Used for "last refreshed", where seconds are the point. */
export function formatIstClock(iso: string): string {
  return IST_CLOCK.format(new Date(iso));
}
