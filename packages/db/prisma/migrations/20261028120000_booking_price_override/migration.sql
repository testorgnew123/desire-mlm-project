-- An admin's agreed final price for a plot (null = priced from the price list).
-- Additive and nullable: existing bookings are untouched.
ALTER TABLE "bookings" ADD COLUMN "priceOverride" DECIMAL(18,2);
