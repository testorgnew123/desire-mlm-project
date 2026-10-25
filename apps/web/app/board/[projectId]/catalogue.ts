// The unit catalogue as it travels from the server to the browser.
//
// A plotted project is hundreds to thousands of units, and almost everything
// about a unit is shared with its neighbours (its type, its block) or empty (no
// hold, no block reason, no tags). Sent as plain objects, every one of those
// repeated or empty values was written out once per unit: about 480 bytes a unit,
// 1.1 MB for 2,000 plots -- which the server serialises and compresses on every
// render and the phone downloads and parses before it can draw a tile. This sends
// each unit type and each block once, leaves empty fields out, and rebuilds the
// plain BoardUnit in the browser, so nothing downstream of it changes.
//
// This file is imported by client components: types and one pure function, no
// server imports. The server half (build-catalogue.ts) uses formatArea and the
// lazy-expiry rule, which pull in packages a browser bundle must not carry.
import type { UnitStatus } from "@desire/db";
import type { BoardTower, BoardUnit } from "./types";

/** What every unit of one unit type has in common. */
export interface CatalogueType {
  id: string;
  code: string;
  name: string;
  bedrooms: number | null;
  /** The type's own areas, already formatted. A unit with a measured area of its
   *  own carries that instead (CatalogueEntry.carpetArea / saleableArea). */
  carpetArea: string | null;
  builtUpArea: string | null;
  saleableArea: string;
}

/** One unit minus whatever it shares with its type and block or leaves empty.
 *  A missing field means the common or empty value; expandCatalogue puts it back. */
export interface CatalogueEntry {
  id: string;
  unitNumber: string;
  status: UnitStatus;
  updatedAt: string;
  /** Position in Catalogue.types. */
  type: number;
  /** Position in Catalogue.towers; missing for a unit outside any block. */
  tower?: number;
  floor?: number;
  facing?: string;
  plcTags?: string[];
  carpetArea?: string;
  saleableArea?: string;
  blockReason?: string;
  currentHoldExpiresAt?: string;
  heldByName?: string;
  heldByCode?: string;
  /** Only ever true: the live hold is the viewer's own. */
  isMine?: true;
}

export interface Catalogue {
  types: CatalogueType[];
  towers: BoardTower[];
  units: CatalogueEntry[];
}

/** A unit as the screens use it. The board reads the BoardUnit part; the phone
 *  grid also reads the block it sits in and whether the live hold is the viewer's. */
export type CatalogueUnit = BoardUnit & {
  towerCode: string | null;
  towerKind: BoardTower["kind"] | null;
  isMine: boolean;
};

export function expandCatalogue(catalogue: Catalogue): { towers: BoardTower[]; units: CatalogueUnit[] } {
  const { types, towers } = catalogue;
  const units = catalogue.units.map((entry): CatalogueUnit => {
    const type = types[entry.type]!;
    const tower = entry.tower === undefined ? null : towers[entry.tower]!;
    return {
      id: entry.id,
      unitNumber: entry.unitNumber,
      floor: entry.floor ?? null,
      towerId: tower?.id ?? null,
      towerCode: tower?.code ?? null,
      towerKind: tower?.kind ?? null,
      facing: entry.facing ?? null,
      plcTags: entry.plcTags ?? [],
      unitTypeId: type.id,
      unitTypeCode: type.code,
      unitTypeName: type.name,
      bedrooms: type.bedrooms,
      carpetArea: entry.carpetArea ?? type.carpetArea,
      builtUpArea: type.builtUpArea,
      saleableArea: entry.saleableArea ?? type.saleableArea,
      blockReason: entry.blockReason ?? null,
      status: entry.status,
      currentHoldExpiresAt: entry.currentHoldExpiresAt ?? null,
      heldByName: entry.heldByName ?? null,
      heldByCode: entry.heldByCode ?? null,
      isMine: entry.isMine ?? false,
      updatedAt: entry.updatedAt,
    };
  });
  return { towers, units };
}
