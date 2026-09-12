import type { ActivityType, LeadStage } from "@desire/db";

export const STAGES: LeadStage[] = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "SITE_VISIT_SCHEDULED",
  "SITE_VISIT_DONE",
  "NEGOTIATION",
  "BOOKED",
  "LOST",
  "DORMANT",
];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  SITE_VISIT_SCHEDULED: "Site visit scheduled",
  SITE_VISIT_DONE: "Site visit done",
  NEGOTIATION: "Negotiation",
  BOOKED: "Booked",
  LOST: "Lost",
  DORMANT: "Dormant",
};

export const ACTIVITY_TYPES: ActivityType[] = ["CALL", "WHATSAPP", "EMAIL", "MEETING", "SITE_VISIT", "NOTE", "STAGE_CHANGE"];

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  CALL: "Call",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  MEETING: "Meeting",
  SITE_VISIT: "Site visit",
  NOTE: "Note",
  STAGE_CHANGE: "Stage change",
};
