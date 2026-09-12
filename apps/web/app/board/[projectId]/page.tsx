// The live inventory board -- "the screen the project is judged on"
// (docs/08-SCREENS.md, "The three screens that carry the product").
//
// Split deliberately. This Server Component loads the catalogue a delta poll
// can never carry -- tower, unit type, areas, facing, PLC tags -- plus one
// snapshot of live state. InventoryBoard.tsx owns everything that changes,
// because GET /projects/:id/units/deltas returns only
// {id, unitNumber, floor, status, currentHoldExpiresAt, updatedAt}
// (docs/06-INVENTORY-SPEC.md section 6).
//
// Gated with exactly the auth the delta endpoint uses -- same session cookie
// (via lib/session.ts's getSession()), same assertPermission("unit.read",
// { projectId }). The two have to agree: a page that rendered for an
// anonymous caller would then poll
// an endpoint that answers 401 to that same caller, so the board would paint
// once and show "Refresh failed (HTTP 401)" from the first poll onward, which
// reads as a flaky network rather than as a missing session.
//
// Every read below is additionally scoped by the session's own orgId. Project,
// Unit and UnitHold all carry the column, and packages/db/prisma/schema.prisma
// states the convention ("Every table carries orgId") -- that scoping is what
// makes a guessed cuid return notFound() instead of another tenant's stock,
// including the holding associate's name and code. Inventory reads are
// permission- and org-scoped in docs/09-RBAC-MATRIX.md.
//
// Two things this file cannot close, both reported:
//   - apps/web/package.json declares only @desire/db, so the @desire/services
//     import below does not resolve. The dependency has to be added there (the
//     deltas and expire routes need it too); nothing here can substitute.
//   - getUnitDeltas filters on projectId alone (packages/services/src/units.ts),
//     so the poll this page starts is still not org-scoped even though the
//     first paint now is. The filter belongs next to that query.
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
// Narrow subpath imports -- see the note in the deltas route: the barrel drags
// a native .node addon into the build graph via auth.ts.
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { effectiveUnitStatus } from "@desire/services/holds";
import { getSession } from "@/lib/session";
import { formatArea } from "@/lib/money";
import { InventoryBoard } from "./InventoryBoard";
import type { BoardTower, BoardUnit } from "./types";

// Inventory that is cached is inventory that is wrong, which is the one thing
// this screen exists to prevent.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live inventory board",
};

// Stated here rather than inherited: "usable one-handed at 360px" is a hard
// requirement for this screen (docs/08-SCREENS.md, docs/12-NFR.md) and
// apps/web/app/layout.tsx declares no viewport of its own.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function InventoryBoardPage({
  params,
}: {
  // Next.js 15 changed route params to a promise.
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const db = getPrismaClient();

  // Actor resolved ONCE per render (docs/07-API.md, Auth row) -- getSession's
  // validateSession call writes lastActiveAt, so a second call would refresh
  // the idle timeout twice for one page view.
  const session = await resolveBoardReader(projectId);
  const orgId = session.user.orgId;

  // Taken BEFORE the reads, deliberately. This timestamp becomes the client's
  // first `?since`, and a `since` taken after the read would silently drop any
  // unit that changed while these queries were running -- a unit held during
  // page load would never appear as held. Taking it early only costs a few
  // redundant rows on the first poll.
  const readStartedAt = new Date();

  const project = await db.project.findUnique({
    where: { id: projectId, orgId },
    select: {
      id: true,
      code: true,
      name: true,
      city: true,
      towers: {
        select: { id: true, code: true, name: true },
        orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      },
    },
  });
  if (!project) notFound();

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
        select: {
          id: true,
          code: true,
          name: true,
          bedrooms: true,
          carpetArea: true,
          builtUpArea: true,
          saleableArea: true,
        },
      },
    },
    orderBy: [{ floor: "desc" }, { unitNumber: "asc" }],
  });

  // currentHoldId is a denormalised pointer with no Prisma relation on Unit
  // (packages/db/prisma/schema.prisma), so the live holds are a second read --
  // the same shape getUnitDeltas uses. The orgId predicate is belt and braces
  // here (the ids came from units already scoped to this org) but it is what
  // stops a future change to how holdIds are gathered from quietly turning
  // this into a cross-tenant read of an associate's name.
  const holdIds = rows
    .map((row) => row.currentHoldId)
    .filter((id): id is string => id !== null);
  const holds = holdIds.length
    ? await db.unitHold.findMany({
        where: { orgId, id: { in: holdIds } },
        select: {
          id: true,
          expiresAt: true,
          releasedAt: true,
          associate: { select: { code: true, user: { select: { name: true } } } },
        },
      })
    : [];
  const holdById = new Map(holds.map((hold) => [hold.id, hold]));

  const units: BoardUnit[] = rows.map((row) => {
    const hold = row.currentHoldId ? (holdById.get(row.currentHoldId) ?? null) : null;
    // The same lazy-expiry rule the delta endpoint applies, from the same
    // function: a hold past expiresAt reads as AVAILABLE even before the
    // five-minute sweep materialises the release (docs/06-INVENTORY-SPEC.md
    // section 3). Re-implementing it here would let the first paint disagree
    // with the first poll a minute later.
    const status = effectiveUnitStatus({ status: row.status }, hold, readStartedAt);
    const liveHold = status === "HELD" ? hold : null;

    return {
      id: row.id,
      unitNumber: row.unitNumber,
      floor: row.floor,
      towerId: row.towerId,
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
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  const towers: BoardTower[] = project.towers.map((tower) => ({
    id: tower.id,
    code: tower.code,
    name: tower.name,
  }));

  return (
    <InventoryBoard
      projectId={project.id}
      projectName={project.name}
      projectCode={project.code}
      city={project.city}
      towers={towers}
      units={units}
      serverTime={readStartedAt.toISOString()}
    />
  );
}

/** Resolves the actor and asserts the inventory read permission, or renders the
 *  404. Authorization itself stays in the service layer (docs/10-SECURITY.md,
 *  "Handlers never authorize") -- this only maps the two expected failures onto
 *  what a page can render.
 *
 *  Both land on notFound() rather than on distinct pages -- deliberately not
 *  requireSession()'s redirect-to-/login: a page that said "forbidden" (or
 *  redirected to log in) would confirm this project id exists to someone with
 *  no right to know it, the same reason the deltas route authenticates before
 *  it parses ?since. Anything else thrown is a real fault and belongs in the
 *  error boundary, not swallowed as a 404. */
async function resolveBoardReader(projectId: string) {
  const session = await getSession();
  if (!session) notFound();

  try {
    await assertPermission(getPrismaClient(), session.user.id, "unit.read", { projectId });
    return session;
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
}
