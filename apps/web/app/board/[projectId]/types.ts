/// <reference lib="dom" />
//
// The lib reference above is load-bearing and does not belong here long term.
// apps/web inherits `lib: ["ES2022"]` from tsconfig.base.json and never adds
// "DOM" (apps/web/tsconfig.json overrides `declaration`, `paths` and `jsx` but
// not `lib`), so `document`, `window`, `HTMLButtonElement` and friends are not
// declared -- which no file in apps/web needed until this screen, the first
// client component in the app. A triple-slash lib reference in any file of the
// program adds the lib to the whole program, so one line here unblocks the
// board without touching a file another agent owns. The real fix is
// `"lib": ["ES2022", "DOM", "DOM.Iterable"]` in apps/web/tsconfig.json; move it
// there and delete this. @types/node's web globals (fetch, Response,
// AbortController) are guarded against a present DOM lib, so nothing conflicts.

import type { UnitStatus } from "@desire/db";

export interface BoardTower {
  id: string;
  code: string;
  name: string;
}

/** A unit as the board knows it: the static catalogue the Server Component
 *  loads once, plus the snapshot of live state it was loaded with.
 *
 *  The split matters. The delta poll returns only
 *  `{id, unitNumber, floor, status, currentHoldExpiresAt, updatedAt}`
 *  (docs/06-INVENTORY-SPEC.md section 6), so tower, type, areas, facing and PLC
 *  tags can only come from the initial load. The board keeps this catalogue and
 *  overlays LiveUnitState on top of it. */
export interface BoardUnit {
  id: string;
  unitNumber: string;
  floor: number;
  towerId: string | null;
  facing: string | null;
  plcTags: string[];

  unitTypeId: string;
  unitTypeCode: string;
  unitTypeName: string;
  bedrooms: number | null;

  /** Already formatted server-side. Areas are Decimal in the schema and must
   *  not be round-tripped through a JS number to reach the browser. Always
   *  rendered next to which area it is -- docs/08-SCREENS.md is explicit that a
   *  bare area number is a bug, and docs/19-GLOSSARY.md explains why (quoting a
   *  carpet area against a saleable rate misprices a unit by ~35%). */
  carpetArea: string;
  builtUpArea: string;
  saleableArea: string;

  blockReason: string | null;

  /** Effective status at load time: a hold past its expiresAt already reads as
   *  AVAILABLE here (docs/06-INVENTORY-SPEC.md section 3). */
  status: UnitStatus;
  currentHoldExpiresAt: string | null;
  heldByName: string | null;
  heldByCode: string | null;
  updatedAt: string;
}

/** Exactly the fields a delta can change. */
export interface LiveUnitState {
  status: UnitStatus;
  currentHoldExpiresAt: string | null;
  updatedAt: string;
}

/** Response shape of GET /api/v1/projects/:id/units/deltas?since=
 *  (apps/web/app/api/v1/projects/[projectId]/units/deltas/route.ts). */
export interface DeltaResponse {
  units: Array<{
    id: string;
    unitNumber: string;
    floor: number;
    status: UnitStatus;
    currentHoldExpiresAt: string | null;
    updatedAt: string;
  }>;
  /** Sent back verbatim as the next `?since`. Never the client's own clock. */
  serverTime: string;
}
