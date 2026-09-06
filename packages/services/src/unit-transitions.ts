// Pure Unit state machine -- structural legality only (docs/06-INVENTORY-SPEC.md
// section 1). "Structural" means: is this transition ever allowed, regardless
// of who is asking or what data backs it. Business-rule guards that need DB
// data (hold quota, price list active, RERA validity) live in holds.ts, which
// calls into this table first and then layers its own checks on top.
//
// No @prisma/client import here -- same purity discipline as
// packages/commission, so this table is trivially unit-testable against
// every (state, transition) pair without a database.
import type { UnitStatus } from "@desire/db";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: UnitStatus,
    public readonly to: UnitStatus,
  ) {
    super(`Illegal unit status transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// Every legal (from, to) pair. BLOCKED is handled separately below, since
// "any state -> BLOCKED" and "BLOCKED -> <prior status>" aren't fixed pairs
// in the usual sense -- the target on unblock is whatever the unit's status
// was immediately before it was blocked, not a single hardcoded value.
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [UnitStatus, UnitStatus]> = [
  ["AVAILABLE", "HELD"],
  ["HELD", "AVAILABLE"],
  ["HELD", "BOOKED"],
  ["BOOKED", "AVAILABLE"], // cancellation -- see docs/06-INVENTORY-SPEC.md
  ["BOOKED", "AGREEMENT_SIGNED"],
  ["AGREEMENT_SIGNED", "REGISTERED"],
  ["REGISTERED", "POSSESSION"],
];

const BLOCKABLE_FROM: ReadonlySet<UnitStatus> = new Set<UnitStatus>([
  "AVAILABLE",
  "HELD",
  "BOOKED",
  "AGREEMENT_SIGNED",
  "REGISTERED",
  "POSSESSION",
]);

export function isValidTransition(from: UnitStatus, to: UnitStatus): boolean {
  if (to === "BLOCKED") return BLOCKABLE_FROM.has(from);
  // Unblock: structurally, BLOCKED may return to any of the six real states
  // (whichever the unit held before blocking). WHICH one is a data rule --
  // units.ts reads it from UnitStatusHistory and enforces to === prior.
  // BLOCKED -> BLOCKED is never legal.
  if (from === "BLOCKED") return BLOCKABLE_FROM.has(to);
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Throws if illegal. Callers that need a boolean should use
 *  isValidTransition directly; this is for call sites where an illegal
 *  transition is a bug, not a condition to branch on. */
export function assertValidTransition(from: UnitStatus, to: UnitStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
