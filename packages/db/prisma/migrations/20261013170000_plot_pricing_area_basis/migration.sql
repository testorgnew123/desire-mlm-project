-- Plot pricing: an area basis per unit type, optional carpet/built-up areas,
-- and a rate column whose name no longer claims a unit it may not be in.

-- NOTE: `prisma migrate diff` generated a `DROP INDEX
-- "associate_hierarchy_path_prefix"` here and it has been removed by hand,
-- for the second time. That index is the text_pattern_ops one from
-- 20260920185000. Prisma cannot express an operator class, so it is absent
-- from schema.prisma and EVERY generated migration will try to drop it as
-- drift. Dropping it silently returns every "my downline" query to a
-- sequential scan. Strip it again next time.

-- CreateEnum
CREATE TYPE "AreaBasis" AS ENUM ('SQFT', 'SQYD');

-- AlterTable: unit types gain a basis; carpet and built-up become optional
-- because a plot has neither. Existing rows are untouched -- they default to
-- SQFT and keep the areas they already have.
ALTER TABLE "unit_types" ADD COLUMN "areaBasis" "AreaBasis" NOT NULL DEFAULT 'SQFT',
  ALTER COLUMN "carpetArea" DROP NOT NULL,
  ALTER COLUMN "builtUpArea" DROP NOT NULL;

-- RenameColumn, NOT drop-and-add.
--
-- `prisma migrate diff` emitted `DROP COLUMN "baseRatePerSqft", ADD COLUMN
-- "baseRate" NOT NULL` -- Prisma cannot infer a rename. That would have
-- destroyed every existing price-list rate, and on a non-empty table it would
-- have failed outright adding a NOT NULL column with no default. A rename
-- preserves the data and the NOT NULL constraint.
ALTER TABLE "price_list_items" RENAME COLUMN "baseRatePerSqft" TO "baseRate";