import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { getSession } from "@/lib/session";
import { InventoryGrid } from "./InventoryGrid";
import { buildCatalogue } from "@/app/board/[projectId]/build-catalogue";

// Same reasoning as the desktop board: inventory that is cached is
// inventory that is wrong.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory — Desire",
};

/** Mobile, single-column unit list for one project -- the PWA's version of
 *  the desktop board (docs/08-SCREENS.md). Reuses the exact same catalogue
 *  (build-catalogue.ts) and delta-poll hook (useUnitDeltas, via InventoryGrid)
 *  as the desktop screen rather than a second implementation; only the
 *  layout differs (one block at a time, not a tower/floor grid). */
export default async function PwaInventoryProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getPrismaClient();

  const session = await getSession();
  if (!session) notFound();
  const orgId = session.user.orgId;

  const readStartedAt = new Date();

  // Four independent reads, started together. This page used to run them one
  // after another (permission, project, towers, units, associate), and each is a
  // round trip to a database a long way from the function -- so the page took the
  // SUM of them, not the slowest. The permission check is among them rather than
  // before them: nothing read here reaches the response unless it passes, and a
  // caller who fails it (rare) wastes three cheap reads.
  const [permission, project, towers, rows] = await Promise.all([
    assertPermission(db, session.user.id, "unit.read", { projectId }).then(
      () => null,
      (error: unknown) => error,
    ),
    db.project.findUnique({
      where: { id: projectId, orgId },
      select: { id: true, code: true, name: true },
    }),
    db.tower.findMany({
      where: { projectId, orgId },
      select: { id: true, code: true, name: true, kind: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
    }),
    db.unit.findMany({
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
          select: {
            id: true,
            code: true,
            name: true,
            bedrooms: true,
            areaBasis: true,
            carpetArea: true,
            builtUpArea: true,
            saleableArea: true,
          },
        },
      },
      orderBy: [{ floor: "desc" }, { unitNumber: "asc" }],
    }),
  ]);
  if (permission instanceof ForbiddenError) notFound();
  if (permission) throw permission;
  if (!project) notFound();

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

  // viewerUserId marks the live holds that are this associate's own -- a hold
  // is theirs exactly when its associate row belongs to their user, so no
  // separate lookup of their associate profile is needed.
  const catalogue = buildCatalogue({
    rows,
    holds: new Map(holds.map((hold) => [hold.id, hold])),
    towers: towers.map((tower) => ({ id: tower.id, code: tower.code, name: tower.name, kind: tower.kind })),
    now: readStartedAt,
    viewerUserId: session.user.id,
  });

  return (
    <InventoryGrid
      projectId={project.id}
      projectName={project.name}
      catalogue={catalogue}
      serverTime={readStartedAt.toISOString()}
    />
  );
}
