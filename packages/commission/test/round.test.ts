import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { round2 } from "../src/round";

describe("round2", () => {
  it("rounds half up at the second decimal place", () => {
    expect(round2(new Decimal("5.005")).toString()).toBe("5.01");
    // decimal.js's toString() prints the canonical value, not a padded
    // string -- it does not preserve trailing zeros (5.00 and 5 are the same
    // Decimal). This matches how every grossAmount.toString() assertion in
    // this suite already behaves; 2dp padding for display is a UI concern
    // (.toFixed(2)), not this function's.
    expect(round2(new Decimal("5.004")).toString()).toBe("5");
  });

  it("leaves an already-2dp value unchanged", () => {
    expect(round2(new Decimal("150000.00")).toString()).toBe("150000");
  });
});
