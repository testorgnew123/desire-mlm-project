-- Remove GST.
--
-- Drops every GST column and the GST charge category. DESTRUCTIVE: the GST
-- amounts stored on existing bookings, cost sheet lines, demands and payout
-- lines are erased, and cannot be recovered without a backup restore.
--
-- Booking agreement values are stored as totals and are not changed, so an old
-- booking still shows what it was signed for. A demand is different: its amount
-- never included GST, so after this an open demand is owed for its amount alone
-- and any GST that had been added on top of it is no longer owed.
--
-- A charge head filed under the GST category (none are seeded) is moved to OTHER
-- first, or the enum rewrite below would fail on it.
UPDATE "charge_heads" SET "category" = 'OTHER' WHERE "category" = 'GST';

-- AlterEnum
BEGIN;
CREATE TYPE "ChargeCategory_new" AS ENUM ('BASE_PRICE', 'PLC', 'PARKING', 'CLUB_MEMBERSHIP', 'IFMS', 'ELECTRICITY_WATER', 'POWER_BACKUP', 'LEGAL_DOCUMENTATION', 'STAMP_DUTY', 'REGISTRATION', 'OTHER');
ALTER TABLE "charge_heads" ALTER COLUMN "category" TYPE "ChargeCategory_new" USING ("category"::text::"ChargeCategory_new");
ALTER TYPE "ChargeCategory" RENAME TO "ChargeCategory_old";
ALTER TYPE "ChargeCategory_new" RENAME TO "ChargeCategory";
DROP TYPE "ChargeCategory_old";
COMMIT;

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "gstin";

-- AlterTable
ALTER TABLE "associates" DROP COLUMN "gstin",
DROP COLUMN "isGstRegistered";

-- AlterTable
ALTER TABLE "charge_heads" DROP COLUMN "gstRatePct",
DROP COLUMN "isTaxable";

-- AlterTable
ALTER TABLE "bookings" DROP COLUMN "gstAmount";

-- AlterTable
ALTER TABLE "cost_sheet_lines" DROP COLUMN "gstAmount",
DROP COLUMN "gstRatePct";

-- AlterTable
ALTER TABLE "demands" DROP COLUMN "gstAmount";

-- AlterTable
ALTER TABLE "payout_batches" DROP COLUMN "totalGst";

-- AlterTable
ALTER TABLE "payout_lines" DROP COLUMN "gstAmount",
DROP COLUMN "gstRatePct";
