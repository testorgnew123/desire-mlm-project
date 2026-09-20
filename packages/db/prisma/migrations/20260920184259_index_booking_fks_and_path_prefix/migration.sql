-- DropIndex
DROP INDEX "associate_hierarchy_path_idx";

-- CreateIndex
CREATE INDEX "bookings_unitId_idx" ON "bookings"("unitId");

-- CreateIndex
CREATE INDEX "bookings_leadId_idx" ON "bookings"("leadId");
