import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { effectiveUnitStatus } from "@desire/services/holds";
import { formatArea } from "@/lib/money";
import { getSession } from "@/lib/session";
import { InventoryList } from "./InventoryList";
import type { BoardUnit } from "@/app/board/[projectId]/types";

// Same reasoning as the desktop board: inventory that is cached is
// inventory that is wrong.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory — Desire",
};

/** Mobile, single-column unit list for one project -- the PWA's version of
 *  the desktop board (docs/08-SCREENS.md). Reuses the exact same catalogue
 *  shape (BoardUnit) and delta-poll hook (useUnitDeltas, via InventoryList)
 *  as the desktop screen rather than a second implementation; only the
 *  layout differs (flat list, not a tower/floor grid). */
export default async function PwaInventoryProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getPrismaClient();

  const session = await getSession();
  if (!session) notFound();
  try {
    await assertPermission(db, session.user.id, "unit.read", { projectId });
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  const orgId = session.user.orgId;

  const readStartedAt = new Date();

  const project = await db.project.findUnique({
    where: { id: projectId, orgId },
    select: { id: true, code: true, name: true },
  });
  if (!project) notFound();

  const towers = await db.tower.findMany({
    where: { projectId, orgId },
    select: { id: true, code: true },
  });
  const towerCodeById = new Map(towers.map((tower) => [tower.id, tower.code]));

  const rows = await db.unit.findMany({
    where: { orgId, projectId },
    select: {
      id: true,
      unitNumber: true,
      floor: true,
      towerId: true,
      facing: true,
      plcTags: true,
      status: true,
      blockReason: true,
      currentHoldId: true,
      updatedAt: true,
      carpetAreaOverride: true,
      saleableAreaOverride: true,
      unitType: {
        select: { id: true, code: true, name: true, bedrooms: true, carpetArea: true, builtUpArea: true, saleableArea: true },
      },
    },
    orderBy: [{ floor: "desc" }, { unitNumber: "asc" }],
  });

  const holdIds = rows.map((row) => row.currentHoldId).filter((id): id is string => id !== null);
  const holds = holdIds.length
    ? await db.unitHold.findMany({
        where: { orgId, id: { in: holdIds } },
        select: {
          id: true,
          expiresAt: true,
          releasedAt: true,
          associate: { select: { code: true, userId: true, user: { select: { name: true } } } },
        },
      })
    : [];
  const holdById = new Map(holds.map((hold) => [hold.id, hold]));

  const myAssociate = await db.associate.findUnique({ where: { userId: session.user.id }, select: { id: true } });

  const units: (BoardUnit & { towerCode: string | null; isMine: boolean })[] = rows.map((row) => {
    const hold = row.currentHoldId ? (holdById.get(row.currentHoldId) ?? null) : null;
    const status = effectiveUnitStatus({ status: row.status }, hold, readStartedAt);
    const liveHold = status === "HELD" ? hold : null;

    return {
      id: row.id,
      unitNumber: row.unitNumber,
      floor: row.floor,
      towerId: row.towerId,
      towerCode: row.towerId ? (towerCodeById.get(row.towerId) ?? null) : null,
      facing: row.facing,
      plcTags: row.plcTags,
      unitTypeId: row.unitType.id,
      unitTypeCode: row.unitType.code,
      unitTypeName: row.unitType.name,
      bedrooms: row.unitType.bedrooms,
      carpetArea: formatArea(row.carpetAreaOverride ?? row.unitType.carpetArea, "carpet"),
      builtUpArea: formatArea(row.unitType.builtUpArea, "builtUp"),
      saleableArea: formatArea(row.saleableAreaOverride ?? row.unitType.saleableArea, "saleable"),
      blockReason: row.blockReason,
      status,
      currentHoldExpiresAt: liveHold ? liveHold.expiresAt.toISOString() : null,
      heldByName: liveHold ? liveHold.associate.user.name : null,
      heldByCode: liveHold ? liveHold.associate.code : null,
      isMine: !!(myAssociate && liveHold && liveHold.associate.userId === session.user.id),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return (
    <InventoryList
      projectId={project.id}
      projectName={project.name}
      units={units}
      serverTime={readStartedAt.toISOString()}
    />
  );
}
