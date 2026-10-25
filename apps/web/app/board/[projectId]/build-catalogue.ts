// Server half of the catalogue (see catalogue.ts for why it exists). Both the
// desktop board and the phone grid build theirs here, which also puts the lazy
// hold-expiry rule in one place: it used to be copied into each page, and the
// comment on the copy said why that is dangerous -- a first paint that disagrees
// with the first delta poll a minute later.
import type { AreaBasis, UnitStatus } from "@desire/db";
import { effectiveUnitStatus } from "@desire/services/holds";
import { formatArea } from "@/lib/money";
import type { Catalogue, CatalogueEntry, CatalogueType } from "./catalogue";
import type { BoardTower } from "./types";

type AreaValue = Parameters<typeof formatArea>[0];

/** A unit row as both pages read it. */
export interface CatalogueRow {
  id: string;
  unitNumber: string;
  floor: number | null;
  towerId: string | null;
  facing: string | null;
  plcTags: string[];
  status: UnitStatus;
  blockReason: string | null;
  currentHoldId: string | null;
  updatedAt: Date;
  carpetAreaOverride: AreaValue;
  saleableAreaOverride: AreaValue;
  unitType: {
    id: string;
    code: string;
    name: string;
    bedrooms: number | null;
    areaBasis: AreaBasis;
    carpetArea: AreaValue;
    builtUpArea: AreaValue;
    saleableArea: AreaValue;
  };
}

export interface CatalogueHold {
  expiresAt: Date;
  releasedAt: Date | null;
  associate: { code: string; userId?: string; user: { name: string } };
}

export function buildCatalogue(input: {
  rows: readonly CatalogueRow[];
  /** The rows' holds, by hold id. */
  holds: ReadonlyMap<string, CatalogueHold>;
  towers: readonly BoardTower[];
  now: Date;
  /** When given, the live holds that belong to this user are marked isMine. */
  viewerUserId?: string;
}): Catalogue {
  const towerIndex = new Map(input.towers.map((tower, index) => [tower.id, index]));
  const typeIndex = new Map<string, number>();
  const types: CatalogueType[] = [];

  const units = input.rows.map((row): CatalogueEntry => {
    const type = row.unitType;
    let position = typeIndex.get(type.id);
    if (position === undefined) {
      position = types.length;
      typeIndex.set(type.id, position);
      types.push({
        id: type.id,
        code: type.code,
        name: type.name,
        bedrooms: type.bedrooms,
        carpetArea: formatArea(type.carpetArea, "carpet", type.areaBasis),
        builtUpArea: formatArea(type.builtUpArea, "builtUp", type.areaBasis),
        saleableArea: formatArea(type.saleableArea, "saleable", type.areaBasis)!,
      });
    }

    const hold = row.currentHoldId ? (input.holds.get(row.currentHoldId) ?? null) : null;
    const status = effectiveUnitStatus({ status: row.status }, hold, input.now);
    const liveHold = status === "HELD" ? hold : null;

    const entry: CatalogueEntry = {
      id: row.id,
      unitNumber: row.unitNumber,
      status,
      updatedAt: row.updatedAt.toISOString(),
      type: position,
    };
    const tower = row.towerId === null ? undefined : towerIndex.get(row.towerId);
    if (tower !== undefined) entry.tower = tower;
    if (row.floor !== null) entry.floor = row.floor;
    if (row.facing !== null) entry.facing = row.facing;
    if (row.plcTags.length > 0) entry.plcTags = row.plcTags;
    if (row.carpetAreaOverride !== null) entry.carpetArea = formatArea(row.carpetAreaOverride, "carpet", type.areaBasis)!;
    if (row.saleableAreaOverride !== null) {
      entry.saleableArea = formatArea(row.saleableAreaOverride, "saleable", type.areaBasis)!;
    }
    if (row.blockReason !== null) entry.blockReason = row.blockReason;
    if (liveHold) {
      entry.currentHoldExpiresAt = liveHold.expiresAt.toISOString();
      entry.heldByName = liveHold.associate.user.name;
      entry.heldByCode = liveHold.associate.code;
      if (input.viewerUserId !== undefined && liveHold.associate.userId === input.viewerUserId) entry.isMine = true;
    }
    return entry;
  });

  return { types, towers: [...input.towers], units };
}
