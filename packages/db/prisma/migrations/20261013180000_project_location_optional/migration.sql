-- City and state become optional on a project.
--
-- A project is usually created the day the land deal closes, before anyone has
-- written down an address, and the form demanded both. Nothing keys off either
-- column -- they are display only -- so an unknown one is null rather than an
-- empty string that every reader would then have to special-case anyway.
--
-- Existing rows keep their values; this only drops the constraint.

-- NOTE: `prisma migrate diff` generated a `DROP INDEX
-- "associate_hierarchy_path_prefix"` here and it has been removed by hand, for
-- the FOURTH time. That index is the text_pattern_ops one from
-- 20260920185000. Prisma cannot express an operator class, so it is absent
-- from schema.prisma and EVERY generated migration will try to drop it as
-- drift. Dropping it returns every "my downline" query to a sequential scan.
-- Strip it again next time.

ALTER TABLE "projects" ALTER COLUMN "city" DROP NOT NULL,
  ALTER COLUMN "state" DROP NOT NULL;
