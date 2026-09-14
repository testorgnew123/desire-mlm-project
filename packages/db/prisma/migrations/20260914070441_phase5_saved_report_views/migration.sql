-- CreateTable
CREATE TABLE "saved_report_views" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "scheduleCron" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_report_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_report_views_orgId_userId_idx" ON "saved_report_views"("orgId", "userId");

-- CreateIndex
CREATE INDEX "saved_report_views_scheduleCron_idx" ON "saved_report_views"("scheduleCron");

-- AddForeignKey
ALTER TABLE "saved_report_views" ADD CONSTRAINT "saved_report_views_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_views" ADD CONSTRAINT "saved_report_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
