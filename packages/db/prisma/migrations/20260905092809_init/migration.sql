-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "EngagementType" AS ENUM ('EMPLOYEE', 'CONSULTANT', 'CHANNEL_PARTNER');

-- CreateEnum
CREATE TYPE "AssociateStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'EXITED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'PRE_LAUNCH', 'LAUNCHED', 'SELLING', 'SOLD_OUT', 'COMPLETED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('AVAILABLE', 'HELD', 'BOOKED', 'AGREEMENT_SIGNED', 'REGISTERED', 'POSSESSION', 'BLOCKED');

-- CreateEnum
CREATE TYPE "HoldReleaseReason" AS ENUM ('EXPIRED', 'RELEASED_BY_ASSOCIATE', 'RELEASED_BY_ADMIN', 'CONVERTED_TO_BOOKING', 'UNIT_BLOCKED');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChargeCategory" AS ENUM ('BASE_PRICE', 'PLC', 'PARKING', 'CLUB_MEMBERSHIP', 'IFMS', 'ELECTRICITY_WATER', 'POWER_BACKUP', 'LEGAL_DOCUMENTATION', 'GST', 'STAMP_DUTY', 'REGISTRATION', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WALK_IN', 'REFERRAL', 'WEBSITE', 'PORTAL_99ACRES', 'PORTAL_MAGICBRICKS', 'PORTAL_HOUSING', 'SOCIAL_MEDIA', 'CAMPAIGN', 'CHANNEL_PARTNER', 'COLD_CALL', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_DONE', 'NEGOTIATION', 'BOOKED', 'LOST', 'DORMANT');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'SITE_VISIT', 'NOTE', 'STAGE_CHANGE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'AGREEMENT_SIGNED', 'REGISTERED', 'POSSESSION_GIVEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DemandStatus" AS ENUM ('SCHEDULED', 'RAISED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "ReceiptMode" AS ENUM ('CHEQUE', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'CARD', 'CASH', 'DEMAND_DRAFT', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('ENTERED', 'VERIFIED', 'CLEARED', 'BOUNCED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FollowUpOutcome" AS ENUM ('CONTACTED_WILL_PAY', 'CONTACTED_DISPUTED', 'CONTACTED_REQUESTED_EXTENSION', 'NO_ANSWER', 'WRONG_NUMBER', 'ESCALATED');

-- CreateEnum
CREATE TYPE "RateType" AS ENUM ('PCT_OF_BASE', 'PER_SQFT', 'FLAT');

-- CreateEnum
CREATE TYPE "CompressionMode" AS ENUM ('NONE', 'ROLL_UP');

-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('PRO_RATA_COLLECTION', 'MILESTONE', 'ON_BOOKING');

-- CreateEnum
CREATE TYPE "ReleaseTriggerType" AS ENUM ('BOOKING_CONFIRMED', 'COLLECTION_PCT', 'DEMAND_PAID', 'AGREEMENT_SIGNED', 'REGISTRATION', 'POSSESSION');

-- CreateEnum
CREATE TYPE "CommissionRole" AS ENUM ('SELF', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "CommissionEntryStatus" AS ENUM ('ACCRUED', 'PAYABLE', 'ON_HOLD', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXPORTED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('OUTSTANDING', 'PARTIALLY_RECOVERED', 'RECOVERED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('CREDIT', 'DEBIT', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "TdsSection" AS ENUM ('SEC_192', 'SEC_194H', 'SEC_194J', 'NONE');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('DISCOUNT', 'PRICE_LIST_PUBLISH', 'BOOKING_CANCELLATION', 'COMMISSION_SCHEME_PUBLISH', 'GRADE_CHANGE', 'HIERARCHY_MOVE', 'PAYOUT_BATCH', 'RECEIPT_VERIFICATION', 'DEMAND_WAIVER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WHATSAPP', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertRung" AS ENUM ('DUE_MINUS_7', 'DUE_MINUS_3', 'DUE_MINUS_1', 'DUE_TODAY', 'OVERDUE_1', 'OVERDUE_7', 'OVERDUE_15', 'OVERDUE_30', 'PROMISE_BREACHED', 'CHEQUE_BOUNCED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('KYC_PAN', 'KYC_AADHAAR', 'KYC_PASSPORT', 'KYC_PHOTO', 'BANK_PROOF', 'BOOKING_FORM', 'ALLOTMENT_LETTER', 'COST_SHEET', 'AGREEMENT_TO_SALE', 'SALE_DEED', 'RECEIPT_COPY', 'CHEQUE_COPY', 'DEMAND_LETTER', 'COMMISSION_STATEMENT', 'FORM_16A', 'OTHER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'EXPORT', 'VIEW_SENSITIVE', 'IMPERSONATE');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "cin" TEXT,
    "address" JSONB,
    "logoUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "mfaSecret" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnrolledAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "requiresMfa" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "projectId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "associates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "engagementType" "EngagementType" NOT NULL,
    "status" "AssociateStatus" NOT NULL DEFAULT 'ONBOARDING',
    "joinDate" TIMESTAMP(3) NOT NULL,
    "confirmDate" TIMESTAMP(3),
    "exitDate" TIMESTAMP(3),
    "exitReason" TEXT,
    "panEncrypted" TEXT,
    "panLast4" TEXT,
    "aadhaarEncrypted" TEXT,
    "aadhaarLast4" TEXT,
    "bankAccountEncrypted" TEXT,
    "bankAccountLast4" TEXT,
    "bankIfsc" TEXT,
    "bankName" TEXT,
    "bankBranch" TEXT,
    "reraAgentRegNo" TEXT,
    "reraValidTill" TIMESTAMP(3),
    "gstin" TEXT,
    "isGstRegistered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "associates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grades" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "minCumulativeSalesValue" DECIMAL(18,2),
    "minBookingsInPeriod" INTEGER,
    "minTeamSize" INTEGER,
    "minTenureMonths" INTEGER,
    "holdQuota" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "associate_grades" (
    "id" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "reason" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "associate_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "associate_hierarchy" (
    "id" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "associate_hierarchy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hierarchy_change_log" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "fromParentId" TEXT,
    "toParentId" TEXT,
    "reason" TEXT NOT NULL,
    "movedById" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtreeSize" INTEGER NOT NULL,

    CONSTRAINT "hierarchy_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "reraRegNo" TEXT,
    "reraValidTill" TIMESTAMP(3),
    "reraPortalUrl" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "launchDate" TIMESTAMP(3),
    "expectedPossessionDate" TIMESTAMP(3),
    "holdTtlMinutes" INTEGER NOT NULL DEFAULT 1440,
    "holdExtensionMinutes" INTEGER NOT NULL DEFAULT 720,
    "maxHoldExtensions" INTEGER NOT NULL DEFAULT 1,
    "holdRequiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "towers" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalFloors" INTEGER NOT NULL,
    "unitsPerFloor" INTEGER,
    "phase" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "towers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_types" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "balconies" INTEGER,
    "carpetArea" DECIMAL(10,2) NOT NULL,
    "builtUpArea" DECIMAL(10,2) NOT NULL,
    "saleableArea" DECIMAL(10,2) NOT NULL,
    "terraceArea" DECIMAL(10,2),
    "floorPlanUrl" TEXT,

    CONSTRAINT "unit_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "towerId" TEXT,
    "unitTypeId" TEXT NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "floor" INTEGER NOT NULL,
    "facing" TEXT,
    "plcTags" TEXT[],
    "carpetAreaOverride" DECIMAL(10,2),
    "saleableAreaOverride" DECIMAL(10,2),
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "blockReason" TEXT,
    "blockedById" TEXT,
    "blockedAt" TIMESTAMP(3),
    "currentHoldId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "preparedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_items" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "unitTypeId" TEXT,
    "unitId" TEXT,
    "baseRatePerSqft" DECIMAL(12,2) NOT NULL,
    "plcCharges" JSONB,
    "otherCharges" JSONB,

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_heads" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ChargeCategory" NOT NULL,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "gstRatePct" DECIMAL(5,2),
    "countsTowardCommission" BOOLEAN NOT NULL DEFAULT false,
    "isRefundable" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "charge_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_holds" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" "HoldReleaseReason",
    "releasedById" TEXT,
    "extensionCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "unit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_status_history" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "fromStatus" "UnitStatus",
    "toStatus" "UnitStatus" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "altPhone" TEXT,
    "phoneHash" TEXT NOT NULL,
    "emailHash" TEXT,
    "source" "LeadSource" NOT NULL,
    "sourceDetail" TEXT,
    "campaignRef" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "lostReason" TEXT,
    "budgetMin" DECIMAL(18,2),
    "budgetMax" DECIMAL(18,2),
    "preferredTypes" TEXT[],
    "requirementNote" TEXT,
    "assignedAssociateId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastContactAt" TIMESTAMP(3),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_claims" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "lead_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "associateId" TEXT,
    "type" "ActivityType" NOT NULL,
    "subject" TEXT,
    "notes" TEXT,
    "outcome" TEXT,
    "fromStage" "LeadStage",
    "toStage" "LeadStage",
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "unitsShown" TEXT[],
    "feedback" TEXT,
    "interestLevel" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "occupation" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',
    "panEncrypted" TEXT,
    "panLast4" TEXT,
    "aadhaarEncrypted" TEXT,
    "aadhaarLast4" TEXT,
    "isNri" BOOLEAN NOT NULL DEFAULT false,
    "passportLast4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "co_applicants" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "panEncrypted" TEXT,
    "panLast4" TEXT,
    "aadhaarEncrypted" TEXT,
    "aadhaarLast4" TEXT,

    CONSTRAINT "co_applicants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "leadId" TEXT,
    "bookingNumber" TEXT NOT NULL,
    "bookingDate" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "sellingAssociateId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "plcAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherChargesAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "stampDutyAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "registrationAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "agreementValue" DECIMAL(18,2) NOT NULL,
    "commissionableValue" DECIMAL(18,2) NOT NULL,
    "creditBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "saleableAreaAtBooking" DECIMAL(10,2) NOT NULL,
    "carpetAreaAtBooking" DECIMAL(10,2) NOT NULL,
    "paymentPlanId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "agreementSignedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "possessionAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "refundPct" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_lines" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "chargeHeadCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2),
    "rate" DECIMAL(12,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "gstRatePct" DECIMAL(5,2),
    "gstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "countsTowardCommission" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cost_sheet_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_status_history" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_requests" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "pctOfBase" DECIMAL(5,2) NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approverRoleCode" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plan_milestones" (
    "id" TEXT NOT NULL,
    "paymentPlanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "pctOfAgreementValue" DECIMAL(7,4) NOT NULL,
    "dueDaysOffset" INTEGER NOT NULL DEFAULT 15,
    "triggerNote" TEXT,

    CONSTRAINT "payment_plan_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demands" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "milestoneRef" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "gstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "raisedAt" TIMESTAMP(3),
    "status" "DemandStatus" NOT NULL DEFAULT 'SCHEDULED',
    "interestRatePctPerAnnum" DECIMAL(5,2),
    "interestAccrued" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "waivedById" TEXT,
    "waivedAt" TIMESTAMP(3),
    "waiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "mode" "ReceiptMode" NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'ENTERED',
    "instrumentNumber" TEXT,
    "instrumentDate" TIMESTAMP(3),
    "drawnOnBank" TEXT,
    "depositedToBank" TEXT,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "clearedOn" TIMESTAMP(3),
    "bouncedOn" TIMESTAMP(3),
    "bounceReason" TEXT,
    "enteredById" TEXT NOT NULL,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_allocations" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_follow_ups" (
    "id" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "contactedOn" TIMESTAMP(3) NOT NULL,
    "outcome" "FollowUpOutcome" NOT NULL,
    "promiseToPayDate" TIMESTAMP(3),
    "promiseBrokenAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_alerts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "rung" "AlertRung" NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients" JSONB NOT NULL,

    CONSTRAINT "collection_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_schemes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "baseDefinition" JSONB NOT NULL,
    "maxLevel" INTEGER NOT NULL DEFAULT 3,
    "compressionMode" "CompressionMode" NOT NULL DEFAULT 'NONE',
    "maxTotalPct" DECIMAL(7,4) NOT NULL DEFAULT 3.0,
    "eligibilityRules" JSONB,
    "preparedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_grade_rates" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "rateType" "RateType" NOT NULL DEFAULT 'PCT_OF_BASE',
    "rateValue" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "scheme_grade_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_level_rates" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "pctOfSellerCommission" DECIMAL(7,4) NOT NULL,

    CONSTRAINT "scheme_level_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_schedules" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "mode" "PayoutMode" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "payout_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_schedule_slabs" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "triggerType" "ReleaseTriggerType" NOT NULL,
    "triggerRef" TEXT,
    "releasePct" DECIMAL(7,4) NOT NULL,

    CONSTRAINT "payout_schedule_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "beneficiaryAssociateId" TEXT NOT NULL,
    "role" "CommissionRole" NOT NULL,
    "level" INTEGER NOT NULL,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "status" "CommissionEntryStatus" NOT NULL DEFAULT 'ACCRUED',
    "snapshot" JSONB NOT NULL,
    "sourceEntryId" TEXT,
    "reversalReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "accruedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_releases" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "triggerType" "ReleaseTriggerType" NOT NULL,
    "triggerRef" TEXT NOT NULL,
    "cumulativePct" DECIMAL(7,4) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_disputes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "raisedById" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "adjustmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalTds" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalGst" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAdjustment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalNetPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "preparedById" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "exportedAt" TIMESTAMP(3),
    "bankFileS3Key" TEXT,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_lines" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "tdsSection" "TdsSection" NOT NULL,
    "tdsRatePct" DECIMAL(5,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gstRatePct" DECIMAL(5,2),
    "gstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "recoveryAdjustment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherAdjustment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL,
    "bankAccountLast4" TEXT,
    "bankIfsc" TEXT,
    "utrNumber" TEXT,
    "statementS3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_line_entries" (
    "payoutLineId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "payout_line_entries_pkey" PRIMARY KEY ("payoutLineId","entryId")
);

-- CreateTable
CREATE TABLE "recoveries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "sourceEntryId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "recoveredAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "outstandingAmount" DECIMAL(18,2) NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "reason" TEXT NOT NULL,
    "writtenOffById" TEXT,
    "writtenOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustments" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "associateId" TEXT NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceRef" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedInBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "noPanRatePct" DECIMAL(5,2),
    "thresholdAmount" DECIMAL(18,2),
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "justification" TEXT,
    "payload" JSONB,
    "requiredRoleCode" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" "NotificationChannel"[],
    "audience" TEXT[],
    "offsetDays" INTEGER,
    "templateKey" TEXT NOT NULL,
    "escalates" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "ruleCode" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_orgId_status_idx" ON "users"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_orgId_email_key" ON "users"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_orgId_code_key" ON "roles"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_resource_idx" ON "permissions"("resource");

-- CreateIndex
CREATE INDEX "user_roles_userId_idx" ON "user_roles"("userId");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "user_roles_projectId_idx" ON "user_roles"("projectId");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_entity_entityId_idx" ON "audit_logs"("orgId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_actorId_createdAt_idx" ON "audit_logs"("orgId", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_action_createdAt_idx" ON "audit_logs"("orgId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_orgId_key_key" ON "feature_flags"("orgId", "key");

-- CreateIndex
CREATE INDEX "documents_orgId_entity_entityId_idx" ON "documents"("orgId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "documents_orgId_type_idx" ON "documents"("orgId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "associates_userId_key" ON "associates"("userId");

-- CreateIndex
CREATE INDEX "associates_orgId_status_idx" ON "associates"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "associates_orgId_code_key" ON "associates"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "grades_orgId_code_key" ON "grades"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "grades_orgId_rank_key" ON "grades"("orgId", "rank");

-- CreateIndex
CREATE INDEX "associate_grades_associateId_validFrom_idx" ON "associate_grades"("associateId", "validFrom");

-- CreateIndex
CREATE INDEX "associate_grades_associateId_validTo_idx" ON "associate_grades"("associateId", "validTo");

-- CreateIndex
CREATE INDEX "associate_hierarchy_associateId_validTo_idx" ON "associate_hierarchy"("associateId", "validTo");

-- CreateIndex
CREATE INDEX "associate_hierarchy_parentId_validTo_idx" ON "associate_hierarchy"("parentId", "validTo");

-- CreateIndex
CREATE INDEX "associate_hierarchy_path_idx" ON "associate_hierarchy"("path");

-- CreateIndex
CREATE INDEX "hierarchy_change_log_orgId_associateId_movedAt_idx" ON "hierarchy_change_log"("orgId", "associateId", "movedAt");

-- CreateIndex
CREATE INDEX "projects_orgId_status_idx" ON "projects"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "projects_orgId_code_key" ON "projects"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "towers_projectId_code_key" ON "towers"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "unit_types_projectId_code_key" ON "unit_types"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "units_currentHoldId_key" ON "units"("currentHoldId");

-- CreateIndex
CREATE INDEX "units_projectId_status_idx" ON "units"("projectId", "status");

-- CreateIndex
CREATE INDEX "units_projectId_towerId_floor_idx" ON "units"("projectId", "towerId", "floor");

-- CreateIndex
CREATE INDEX "units_orgId_updatedAt_idx" ON "units"("orgId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "units_projectId_unitNumber_key" ON "units"("projectId", "unitNumber");

-- CreateIndex
CREATE INDEX "price_lists_projectId_status_validFrom_idx" ON "price_lists"("projectId", "status", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_projectId_version_key" ON "price_lists"("projectId", "version");

-- CreateIndex
CREATE INDEX "price_list_items_priceListId_idx" ON "price_list_items"("priceListId");

-- CreateIndex
CREATE UNIQUE INDEX "charge_heads_orgId_code_key" ON "charge_heads"("orgId", "code");

-- CreateIndex
CREATE INDEX "unit_holds_unitId_releasedAt_idx" ON "unit_holds"("unitId", "releasedAt");

-- CreateIndex
CREATE INDEX "unit_holds_associateId_releasedAt_idx" ON "unit_holds"("associateId", "releasedAt");

-- CreateIndex
CREATE INDEX "unit_holds_expiresAt_releasedAt_idx" ON "unit_holds"("expiresAt", "releasedAt");

-- CreateIndex
CREATE INDEX "unit_status_history_unitId_createdAt_idx" ON "unit_status_history"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "leads_orgId_phoneHash_idx" ON "leads"("orgId", "phoneHash");

-- CreateIndex
CREATE INDEX "leads_orgId_assignedAssociateId_stage_idx" ON "leads"("orgId", "assignedAssociateId", "stage");

-- CreateIndex
CREATE INDEX "leads_orgId_projectId_stage_idx" ON "leads"("orgId", "projectId", "stage");

-- CreateIndex
CREATE INDEX "leads_orgId_createdAt_idx" ON "leads"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_claims_leadId_releasedAt_idx" ON "lead_claims"("leadId", "releasedAt");

-- CreateIndex
CREATE INDEX "lead_claims_associateId_expiresAt_idx" ON "lead_claims"("associateId", "expiresAt");

-- CreateIndex
CREATE INDEX "lead_activities_leadId_createdAt_idx" ON "lead_activities"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_activities_associateId_dueAt_completedAt_idx" ON "lead_activities"("associateId", "dueAt", "completedAt");

-- CreateIndex
CREATE INDEX "site_visits_orgId_scheduledAt_idx" ON "site_visits"("orgId", "scheduledAt");

-- CreateIndex
CREATE INDEX "site_visits_associateId_scheduledAt_idx" ON "site_visits"("associateId", "scheduledAt");

-- CreateIndex
CREATE INDEX "customers_orgId_phone_idx" ON "customers"("orgId", "phone");

-- CreateIndex
CREATE INDEX "co_applicants_customerId_idx" ON "co_applicants"("customerId");

-- CreateIndex
CREATE INDEX "bookings_orgId_status_bookingDate_idx" ON "bookings"("orgId", "status", "bookingDate");

-- CreateIndex
CREATE INDEX "bookings_projectId_status_idx" ON "bookings"("projectId", "status");

-- CreateIndex
CREATE INDEX "bookings_sellingAssociateId_bookingDate_idx" ON "bookings"("sellingAssociateId", "bookingDate");

-- CreateIndex
CREATE INDEX "bookings_customerId_idx" ON "bookings"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_orgId_bookingNumber_key" ON "bookings"("orgId", "bookingNumber");

-- CreateIndex
CREATE INDEX "cost_sheet_lines_bookingId_idx" ON "cost_sheet_lines"("bookingId");

-- CreateIndex
CREATE INDEX "booking_status_history_bookingId_createdAt_idx" ON "booking_status_history"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "discount_requests_bookingId_idx" ON "discount_requests"("bookingId");

-- CreateIndex
CREATE INDEX "discount_requests_status_createdAt_idx" ON "discount_requests"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_plans_orgId_code_key" ON "payment_plans"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_plan_milestones_paymentPlanId_sequence_key" ON "payment_plan_milestones"("paymentPlanId", "sequence");

-- CreateIndex
CREATE INDEX "demands_orgId_status_dueDate_idx" ON "demands"("orgId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "demands_bookingId_dueDate_idx" ON "demands"("bookingId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "demands_bookingId_sequence_key" ON "demands"("bookingId", "sequence");

-- CreateIndex
CREATE INDEX "receipts_bookingId_status_idx" ON "receipts"("bookingId", "status");

-- CreateIndex
CREATE INDEX "receipts_orgId_status_receivedOn_idx" ON "receipts"("orgId", "status", "receivedOn");

-- CreateIndex
CREATE INDEX "receipts_orgId_clearedOn_idx" ON "receipts"("orgId", "clearedOn");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_orgId_receiptNumber_key" ON "receipts"("orgId", "receiptNumber");

-- CreateIndex
CREATE INDEX "receipt_allocations_receiptId_idx" ON "receipt_allocations"("receiptId");

-- CreateIndex
CREATE INDEX "receipt_allocations_demandId_reversedAt_idx" ON "receipt_allocations"("demandId", "reversedAt");

-- CreateIndex
CREATE INDEX "payment_follow_ups_demandId_contactedOn_idx" ON "payment_follow_ups"("demandId", "contactedOn");

-- CreateIndex
CREATE INDEX "payment_follow_ups_associateId_promiseToPayDate_idx" ON "payment_follow_ups"("associateId", "promiseToPayDate");

-- CreateIndex
CREATE INDEX "collection_alerts_orgId_firedAt_idx" ON "collection_alerts"("orgId", "firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "collection_alerts_demandId_rung_key" ON "collection_alerts"("demandId", "rung");

-- CreateIndex
CREATE INDEX "commission_schemes_projectId_status_validFrom_idx" ON "commission_schemes"("projectId", "status", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "commission_schemes_projectId_version_key" ON "commission_schemes"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_grade_rates_schemeId_gradeId_key" ON "scheme_grade_rates"("schemeId", "gradeId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_level_rates_schemeId_level_key" ON "scheme_level_rates"("schemeId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "payout_schedule_slabs_scheduleId_sequence_key" ON "payout_schedule_slabs"("scheduleId", "sequence");

-- CreateIndex
CREATE INDEX "commission_entries_bookingId_idx" ON "commission_entries"("bookingId");

-- CreateIndex
CREATE INDEX "commission_entries_beneficiaryAssociateId_status_idx" ON "commission_entries"("beneficiaryAssociateId", "status");

-- CreateIndex
CREATE INDEX "commission_entries_orgId_status_accruedAt_idx" ON "commission_entries"("orgId", "status", "accruedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_idempotencyKey_key" ON "commission_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "commission_releases_entryId_reversedAt_idx" ON "commission_releases"("entryId", "reversedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commission_releases_entryId_triggerType_triggerRef_key" ON "commission_releases"("entryId", "triggerType", "triggerRef");

-- CreateIndex
CREATE INDEX "commission_disputes_orgId_status_idx" ON "commission_disputes"("orgId", "status");

-- CreateIndex
CREATE INDEX "commission_disputes_entryId_idx" ON "commission_disputes"("entryId");

-- CreateIndex
CREATE INDEX "payout_batches_orgId_status_periodEnd_idx" ON "payout_batches"("orgId", "status", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batches_orgId_batchNumber_key" ON "payout_batches"("orgId", "batchNumber");

-- CreateIndex
CREATE INDEX "payout_lines_associateId_idx" ON "payout_lines"("associateId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_lines_batchId_associateId_key" ON "payout_lines"("batchId", "associateId");

-- CreateIndex
CREATE INDEX "payout_line_entries_entryId_idx" ON "payout_line_entries"("entryId");

-- CreateIndex
CREATE INDEX "recoveries_associateId_status_idx" ON "recoveries"("associateId", "status");

-- CreateIndex
CREATE INDEX "recoveries_orgId_status_idx" ON "recoveries"("orgId", "status");

-- CreateIndex
CREATE INDEX "adjustments_associateId_createdAt_idx" ON "adjustments"("associateId", "createdAt");

-- CreateIndex
CREATE INDEX "adjustments_orgId_type_idx" ON "adjustments"("orgId", "type");

-- CreateIndex
CREATE INDEX "tax_rates_orgId_section_validFrom_idx" ON "tax_rates"("orgId", "section", "validFrom");

-- CreateIndex
CREATE INDEX "approval_requests_orgId_status_type_idx" ON "approval_requests"("orgId", "status", "type");

-- CreateIndex
CREATE INDEX "approval_requests_entity_entityId_idx" ON "approval_requests"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_rules_orgId_code_key" ON "notification_rules"("orgId", "code");

-- CreateIndex
CREATE INDEX "notifications_userId_status_createdAt_idx" ON "notifications"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_orgId_ruleCode_createdAt_idx" ON "notifications"("orgId", "ruleCode", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associates" ADD CONSTRAINT "associates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associates" ADD CONSTRAINT "associates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associate_grades" ADD CONSTRAINT "associate_grades_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associate_grades" ADD CONSTRAINT "associate_grades_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "grades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associate_hierarchy" ADD CONSTRAINT "associate_hierarchy_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "associate_hierarchy" ADD CONSTRAINT "associate_hierarchy_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "associates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "towers" ADD CONSTRAINT "towers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_towerId_fkey" FOREIGN KEY ("towerId") REFERENCES "towers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_unitTypeId_fkey" FOREIGN KEY ("unitTypeId") REFERENCES "unit_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_unitTypeId_fkey" FOREIGN KEY ("unitTypeId") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_heads" ADD CONSTRAINT "charge_heads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_status_history" ADD CONSTRAINT "unit_status_history_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignedAssociateId_fkey" FOREIGN KEY ("assignedAssociateId") REFERENCES "associates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_claims" ADD CONSTRAINT "lead_claims_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "co_applicants" ADD CONSTRAINT "co_applicants_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sellingAssociateId_fkey" FOREIGN KEY ("sellingAssociateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_lines" ADD CONSTRAINT "cost_sheet_lines_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan_milestones" ADD CONSTRAINT "payment_plan_milestones_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demands" ADD CONSTRAINT "demands_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "demands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "demands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_alerts" ADD CONSTRAINT "collection_alerts_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "demands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_schemes" ADD CONSTRAINT "commission_schemes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_schemes" ADD CONSTRAINT "commission_schemes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_grade_rates" ADD CONSTRAINT "scheme_grade_rates_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "commission_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_grade_rates" ADD CONSTRAINT "scheme_grade_rates_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "grades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_level_rates" ADD CONSTRAINT "scheme_level_rates_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "commission_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_schedules" ADD CONSTRAINT "payout_schedules_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "commission_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_schedule_slabs" ADD CONSTRAINT "payout_schedule_slabs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "payout_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "commission_schemes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_beneficiaryAssociateId_fkey" FOREIGN KEY ("beneficiaryAssociateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_releases" ADD CONSTRAINT "commission_releases_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_disputes" ADD CONSTRAINT "commission_disputes_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_lines" ADD CONSTRAINT "payout_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "payout_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_lines" ADD CONSTRAINT "payout_lines_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line_entries" ADD CONSTRAINT "payout_line_entries_payoutLineId_fkey" FOREIGN KEY ("payoutLineId") REFERENCES "payout_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line_entries" ADD CONSTRAINT "payout_line_entries_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recoveries" ADD CONSTRAINT "recoveries_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recoveries" ADD CONSTRAINT "recoveries_sourceEntryId_fkey" FOREIGN KEY ("sourceEntryId") REFERENCES "commission_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "associates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
