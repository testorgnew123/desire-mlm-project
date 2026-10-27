// What the booking page offers each person. The rule decides whether the Confirm
// button exists, so it is tested with the REAL grants of each role (permissionsForRole),
// not hand-picked ones: if the matrix drifts from what the page expects, this fails.
import { describe, expect, it } from "vitest";
import { permissionsForRole, type RoleCode } from "@desire/db";
import { bookingActions } from "../lib/booking-actions";

const holding = (...roles: RoleCode[]) => new Set<string>(roles.flatMap((role) => permissionsForRole(role)));
// What an old TEAM_LEAD or AUDITOR (still on the hosted database) can do with bookings.
const readOnly = new Set<string>(["booking.read"]);

describe("bookingActions: a draft booking", () => {
  it.each([["Admin", holding("ADMIN")], ["Super Admin", holding("SUPER_ADMIN")]])(
    "shows %s a pressable Confirm button while the hold is live",
    (_who, permissions) => {
      expect(bookingActions({ status: "DRAFT", permissions, holdLive: true })).toEqual({
        canConfirm: true,
        confirmDisabled: false,
        confirmNote: null,
        canCancel: false,
      });
    },
  );

  it("draws Confirm but disables it once the hold has lapsed", () => {
    const result = bookingActions({ status: "DRAFT", permissions: holding("ADMIN"), holdLive: false });
    expect(result.canConfirm).toBe(true);
    expect(result.confirmDisabled).toBe(true);
  });

  it.each([
    ["an Associate", holding("ASSOCIATE")],
    ["a person left on an old role", readOnly],
    ["a person with no permissions", new Set<string>()],
  ])("shows %s no Confirm button and says why", (_who, permissions) => {
    const result = bookingActions({ status: "DRAFT", permissions, holdLive: true });
    expect(result.canConfirm).toBe(false);
    expect(result.confirmDisabled).toBe(false);
    expect(result.confirmNote).toMatch(/Only an Admin or a Super Admin can confirm/);
  });
});

describe("bookingActions: a booking that is not a draft", () => {
  it("offers Cancel on a confirmed booking to anyone who may cancel, and nothing to confirm", () => {
    for (const permissions of [holding("ADMIN"), holding("SUPER_ADMIN")]) {
      expect(bookingActions({ status: "CONFIRMED", permissions, holdLive: false })).toEqual({
        canConfirm: false,
        confirmDisabled: false,
        confirmNote: null,
        canCancel: true,
      });
    }
  });

  it("offers an Associate neither, and says nothing about confirming a booking that is already confirmed", () => {
    expect(bookingActions({ status: "CONFIRMED", permissions: holding("ASSOCIATE"), holdLive: false })).toEqual({
      canConfirm: false,
      confirmDisabled: false,
      confirmNote: null,
      canCancel: false,
    });
  });

  it("offers nothing on a cancelled booking", () => {
    expect(bookingActions({ status: "CANCELLED", permissions: holding("SUPER_ADMIN"), holdLive: false })).toMatchObject({
      canConfirm: false,
      canCancel: false,
    });
  });
});
