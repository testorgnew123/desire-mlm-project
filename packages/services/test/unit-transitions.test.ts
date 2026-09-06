// Table-driven over EVERY (from, to) pair -- all 7 statuses x 7 statuses = 49
// combinations, each asserted legal or illegal explicitly. This is the test
// docs/06-INVENTORY-SPEC.md asks for: "legal ones succeed, illegal ones throw".
//
// Written as an explicit expected-legal set rather than mirroring the
// implementation's own table, so a mistake in the implementation can't
// silently define its own correctness.
import { describe, expect, it } from "vitest";
import type { UnitStatus } from "@desire/db";
import {
  InvalidTransitionError,
  assertValidTransition,
  isValidTransition,
} from "../src/unit-transitions";

const ALL_STATUSES: UnitStatus[] = [
  "AVAILABLE",
  "HELD",
  "BOOKED",
  "AGREEMENT_SIGNED",
  "REGISTERED",
  "POSSESSION",
  "BLOCKED",
];

// Independently transcribed from the guard table in docs/06-INVENTORY-SPEC.md
// section 1 -- NOT imported from the implementation.
const EXPECTED_LEGAL = new Set<string>([
  "AVAILABLE->HELD",
  "HELD->AVAILABLE",
  "HELD->BOOKED",
  "BOOKED->AVAILABLE", // cancellation; there is no CANCELLED unit status
  "BOOKED->AGREEMENT_SIGNED",
  "AGREEMENT_SIGNED->REGISTERED",
  "REGISTERED->POSSESSION",
  // Any real status -> BLOCKED
  "AVAILABLE->BLOCKED",
  "HELD->BLOCKED",
  "BOOKED->BLOCKED",
  "AGREEMENT_SIGNED->BLOCKED",
  "REGISTERED->BLOCKED",
  "POSSESSION->BLOCKED",
  // Unblock -> any real status (WHICH one is enforced against history by
  // units.ts, not by the structural table)
  "BLOCKED->AVAILABLE",
  "BLOCKED->HELD",
  "BLOCKED->BOOKED",
  "BLOCKED->AGREEMENT_SIGNED",
  "BLOCKED->REGISTERED",
  "BLOCKED->POSSESSION",
]);

describe("unit state machine -- every (from, to) pair", () => {
  const pairs = ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s", (from, to) => {
    const expected = EXPECTED_LEGAL.has(`${from}->${to}`);
    expect(isValidTransition(from, to)).toBe(expected);

    if (expected) {
      expect(() => assertValidTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertValidTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });

  it("covers all 49 combinations -- no status silently missing from the matrix", () => {
    expect(pairs).toHaveLength(49);
  });
});

describe("specific rules worth stating outright", () => {
  it("no status can transition to itself", () => {
    for (const status of ALL_STATUSES) {
      expect(isValidTransition(status, status)).toBe(false);
    }
  });

  it("AVAILABLE cannot skip straight to BOOKED -- a unit must be held first", () => {
    expect(isValidTransition("AVAILABLE", "BOOKED")).toBe(false);
  });

  it("POSSESSION is terminal apart from blocking", () => {
    for (const to of ALL_STATUSES) {
      expect(isValidTransition("POSSESSION", to)).toBe(to === "BLOCKED");
    }
  });

  it("cancellation is only modelled from BOOKED, not from later stages", () => {
    expect(isValidTransition("BOOKED", "AVAILABLE")).toBe(true);
    expect(isValidTransition("AGREEMENT_SIGNED", "AVAILABLE")).toBe(false);
    expect(isValidTransition("REGISTERED", "AVAILABLE")).toBe(false);
  });
});
