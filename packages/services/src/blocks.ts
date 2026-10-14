// A plotted block and its plots, created as one unit.
//
// A township block is defined by how many plots it holds, the way a tower is by
// its floors. Creating the block and then, separately, its plots would leave an
// empty block behind whenever the second step fails -- and the likely cause (the
// project has no RERA registration yet, which importUnits refuses on) is exactly
// the case a user would hit on a fresh project. So both writes share one
// transaction: either the block and every plot exist, or nothing does.
//
// The plots go through the same importer a CSV upload uses, so a generated plot
// is held to every rule an imported one is: RERA, unique unit numbers, no floor
// inside a block, one genesis history row each, one audit row for the batch.
import { Prisma } from "@desire/db";
import type { PrismaClient, Tower } from "@desire/db";
import type { AuditContext } from "./audit";
import { ForbiddenError } from "./rbac";
import { createTowerInTx, withUniqueCode } from "./projects";
import { PlotCountError, plotNumbers } from "./plot-numbering";
import { UnitImportConflictError, importUnitsInTx, type RawUnitRow } from "./unit-import";

export interface CreateBlockWithPlotsParams {
  projectId: string;
  code: string;
  name: string;
  /** Plots to create inside the block, numbered `<code>-01`, `<code>-02`, ...
   *  Omit or pass 0 for an empty block (which needs no RERA, same as before). */
  plotCount?: number;
  /** UnitType.code every generated plot gets. Required when plotCount > 0. */
  plotUnitTypeCode?: string;
  audit: AuditContext;
}

export interface CreateBlockWithPlotsResult {
  tower: Tower;
  plotsCreated: number;
}

export async function createBlockWithPlots(
  db: PrismaClient,
  params: CreateBlockWithPlotsParams,
): Promise<CreateBlockWithPlotsResult> {
  const actorId = params.audit.actorId;
  if (!actorId) {
    throw new ForbiddenError("Creating a block requires a user actor, not a system actor.");
  }

  // Anything other than "none" must be a valid count, so NaN, 1.5 and 501 are
  // rejected here rather than quietly becoming an empty block.
  const wantsPlots = params.plotCount !== undefined && params.plotCount !== 0;
  const rows: RawUnitRow[] = [];
  if (wantsPlots) {
    if (!params.plotUnitTypeCode) {
      throw new PlotCountError("Choose a plot type for the plots.");
    }
    for (const unitNumber of plotNumbers(params.code, params.plotCount as number)) {
      rows.push({ unitNumber, unitTypeCode: params.plotUnitTypeCode, plcTags: [] });
    }
  }

  return withUniqueCode("Tower code", params.code, () =>
    db.$transaction(
      async (tx) => {
        const tower = await createTowerInTx(
          tx,
          {
            projectId: params.projectId,
            code: params.code,
            name: params.name,
            kind: "BLOCK",
            audit: params.audit,
          },
          actorId,
        );

        if (rows.length > 0) {
          try {
            await importUnitsInTx(
              tx,
              {
                orgId: params.audit.orgId,
                projectId: params.projectId,
                towerId: tower.id,
                rows,
                audit: params.audit,
              },
              actorId,
            );
          } catch (err) {
            // A P2002 here is a unit number -- the block itself was inserted
            // just above -- so it must not reach withUniqueCode and be reported
            // as a duplicate BLOCK code.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
              throw new UnitImportConflictError(params.projectId);
            }
            throw err;
          }
        }

        return { tower, plotsCreated: rows.length };
      },
      // Same ceiling importUnits uses: the platform's synchronous limit.
      { timeout: 10_000 },
    ),
  );
}
