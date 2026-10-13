-- CreateEnum
CREATE TYPE "UnitGroupKind" AS ENUM ('TOWER', 'BLOCK');

-- NOTE: `prisma migrate dev` generated a `DROP INDEX
-- "associate_hierarchy_path_prefix"` here and it has been removed by hand.
--
-- That index is the text_pattern_ops one added in
-- 20260920185000_associate_hierarchy_path_prefix_index. Prisma cannot express
-- an operator class, so it is absent from schema.prisma and every `migrate
-- dev` will try to drop it as drift. Dropping it silently returns every
-- "my downline" query to a sequential scan -- the exact regression
-- rbac-scope.test.ts and the partial-index guard exist to catch.
--
-- Strip this line again on any future generated migration.

-- AlterTable
ALTER TABLE "towers" ADD COLUMN     "kind" "UnitGroupKind" NOT NULL DEFAULT 'TOWER',
ALTER COLUMN "totalFloors" DROP NOT NULL;

-- AlterTable
ALTER TABLE "units" ALTER COLUMN "floor" DROP NOT NULL;
