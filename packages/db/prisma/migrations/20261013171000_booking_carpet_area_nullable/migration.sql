-- A booking freezes the areas it was sold on, because a unit type's areas can
-- change after a sale and the booking must still render the sheet the
-- customer signed. A plot has no carpet area, so that frozen figure is
-- nullable too. Existing bookings keep the values they have.
--
-- Deliberately its own migration rather than an edit to
-- 20261013170000_plot_pricing_area_basis: that one is already applied, and
-- Prisma checksums applied migrations -- editing one breaks every subsequent
-- migrate run with "migration modified after being applied".
ALTER TABLE "bookings" ALTER COLUMN "carpetAreaAtBooking" DROP NOT NULL;
