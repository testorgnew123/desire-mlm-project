// Maps each domain status enum to a Badge tone. Grouped by real business
// meaning (terminal-good / in-progress / terminal-bad / neutral), not by
// alphabetical order or enum position -- docs/12-NFR.md requires status
// never be color-only, so every call site still renders the label text too;
// this only picks which color pairs with it.
import type {
  ApprovalStatus,
  AssociateStatus,
  BookingStatus,
  CommissionEntryStatus,
  LeadStage,
  PayoutBatchStatus,
  ReceiptStatus,
  RecoveryStatus,
  UnitStatus,
} from "@desire/db";

export type BadgeTone = "default" | "secondary" | "outline" | "success" | "warning" | "danger";

export function unitStatusTone(status: UnitStatus): BadgeTone {
  switch (status) {
    case "AVAILABLE":
      return "success";
    case "HELD":
      return "warning";
    case "BOOKED":
    case "AGREEMENT_SIGNED":
    case "REGISTERED":
    case "POSSESSION":
      return "default";
    case "BLOCKED":
      return "danger";
  }
}

export function bookingStatusTone(status: BookingStatus): BadgeTone {
  switch (status) {
    case "DRAFT":
    case "PENDING_APPROVAL":
      return "secondary";
    case "CONFIRMED":
    case "AGREEMENT_SIGNED":
    case "REGISTERED":
    case "POSSESSION_GIVEN":
      return "success";
    case "CANCELLED":
      return "danger";
  }
}

export function leadStageTone(stage: LeadStage): BadgeTone {
  switch (stage) {
    case "NEW":
    case "CONTACTED":
    case "QUALIFIED":
    case "SITE_VISIT_SCHEDULED":
    case "SITE_VISIT_DONE":
    case "NEGOTIATION":
      return "secondary";
    case "BOOKED":
      return "success";
    case "LOST":
    case "DORMANT":
      return "danger";
  }
}

export function receiptStatusTone(status: ReceiptStatus): BadgeTone {
  switch (status) {
    case "ENTERED":
      return "secondary";
    case "VERIFIED":
      return "warning";
    case "CLEARED":
      return "success";
    case "BOUNCED":
    case "CANCELLED":
      return "danger";
  }
}

export function commissionEntryStatusTone(status: CommissionEntryStatus): BadgeTone {
  switch (status) {
    case "ACCRUED":
      return "secondary";
    case "PAYABLE":
      return "warning";
    case "ON_HOLD":
      return "danger";
    case "PAID":
      return "success";
    case "REVERSED":
      return "outline";
  }
}

export function payoutBatchStatusTone(status: PayoutBatchStatus): BadgeTone {
  switch (status) {
    case "DRAFT":
    case "PENDING_APPROVAL":
      return "secondary";
    case "APPROVED":
    case "EXPORTED":
      return "warning";
    case "PAID":
      return "success";
    case "CANCELLED":
      return "danger";
  }
}

export function recoveryStatusTone(status: RecoveryStatus): BadgeTone {
  switch (status) {
    case "OUTSTANDING":
      return "warning";
    case "PARTIALLY_RECOVERED":
      return "secondary";
    case "RECOVERED":
      return "success";
    case "WRITTEN_OFF":
      return "danger";
  }
}

export function associateStatusTone(status: AssociateStatus): BadgeTone {
  switch (status) {
    case "ONBOARDING":
      return "secondary";
    case "ACTIVE":
      return "success";
    case "ON_LEAVE":
    case "NOTICE_PERIOD":
      return "warning";
    case "EXITED":
    case "SUSPENDED":
      return "danger";
  }
}

export function approvalStatusTone(status: ApprovalStatus): BadgeTone {
  switch (status) {
    case "PENDING":
      return "warning";
    case "APPROVED":
      return "success";
    case "REJECTED":
      return "danger";
    case "WITHDRAWN":
      return "outline";
  }
}
