import type { UnitStatus } from "@desire/db";

/** Schema order (packages/db/prisma/schema.prisma, enum UnitStatus). There is
 *  no CANCELLED unit state -- cancellation is a Booking concept that returns
 *  the unit to AVAILABLE (docs/06-INVENTORY-SPEC.md section 1). */
export const UNIT_STATUS_ORDER = [
  "AVAILABLE",
  "HELD",
  "BOOKED",
  "AGREEMENT_SIGNED",
  "REGISTERED",
  "POSSESSION",
  "BLOCKED",
] as const satisfies readonly UnitStatus[];

export interface StatusPresentation {
  /** Tile label. Has to stay readable in an 88px tile at 360px width. */
  short: string;
  /** Filter chip, drawer badge, and the accessible name of every tile. */
  long: string;
  /** A second, non-colour channel. */
  glyph: string;
  /** Class in board.module.css carrying this status' colour tokens and border
   *  treatment (solid / dashed / double / dotted / hatched). */
  tone: string;
}

/** Status is carried on FOUR redundant channels: colour, a text label, a glyph,
 *  and a border treatment. docs/12-NFR.md and docs/08-SCREENS.md both call out
 *  no-colour-only status as a real requirement rather than a nicety -- a
 *  colour-blind associate has to be able to read this grid standing on site. */
export const STATUS_PRESENTATION: Record<UnitStatus, StatusPresentation> = {
  AVAILABLE: { short: "AVAIL", long: "Available", glyph: "○", tone: "toneAvailable" },
  HELD: { short: "HELD", long: "Held", glyph: "◐", tone: "toneHeld" },
  BOOKED: { short: "BOOKED", long: "Booked", glyph: "●", tone: "toneBooked" },
  AGREEMENT_SIGNED: {
    short: "AGREED",
    long: "Agreement signed",
    glyph: "◆",
    tone: "toneAgreement",
  },
  REGISTERED: { short: "REGD", long: "Registered", glyph: "■", tone: "toneRegistered" },
  POSSESSION: { short: "POSS", long: "Possession", glyph: "✔", tone: "tonePossession" },
  BLOCKED: { short: "BLOCK", long: "Blocked", glyph: "✕", tone: "toneBlocked" },
};
