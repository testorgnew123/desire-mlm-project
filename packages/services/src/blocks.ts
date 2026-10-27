// A plotted block and its plots, created as one unit.
//
// A township block is defined by how many plots it holds, the way a tower is by
// its floors. Creating the block and then, separately, its plots would leave an
// empty block behind whenever the second step fails (a clashing plot number, a
// plot type that is not a plot, a missing permission). So both writes share one
// transaction: either the block and every plot exist, or nothing does.
//
// The plots go through the same importer a CSV upload uses, so a generated plot
// is held to every rule an imported one is: unique unit numbers, no floor
// inside a block, one genesis history row each, one audit row for the batch.
import { Prisma } from "@desire/db";
import type { PrismaClient, Tower } from "@desire/db";
import type { AuditContext } from "./audit";
import { ForbiddenError } from "./rbac";
import { createTowerInTx, withUniqueCode } from "./projects";
import { PlotCountError, plotAssignments } from "./plot-numbering";
import { UnitImportConflictError, importUnitsInTx, type RawUnitRow } from "./unit-import";

export interface CreateBlockWithPlotsParams {
  projectId: string;
  code: string;
  name: string;
  /** Plots to create inside the block, as runs of one size each: A-01.. for the
   *  first run, the next run carries on. A block with three sizes is three
   *  groups. Omit for an empty block. */
  plotGroups?: Array<{ count: number; unitTypeCode: string }>;
  /** One size only: shorthand for a single group. Cannot be combined with
   *  plotGroups. Omit or pass 0 for none. */
  plotCount?: number;
  /** UnitType.code every plot of `plotCount` gets. Required when plotCount > 0. */
  plotUnitTypeCode?: string;
  audit: AuditContext;
}

export interface CreateBlockWithPlotsResult {
  tower: Tower;
  plotsCreated: number;
  /** Plots made per UnitType.code. */
  byUnitType: Record<string, number>;
}

export async function createBlockWithPlots(
  db: PrismaClient,
  params: CreateBlockWithPlotsParams,
): Promise<CreateBlockWithPlotsResult> {
  const actorId = params.audit.actorId;
  if (!actorId) {
    throw new ForbiddenError("Creating a block requires a user actor, not a system actor.");
  }

  const wantsSingle = params.plotCount !== undefined && params.plotCount !== 0;
  if (wantsSingle && params.plotGroups !== undefined) {
    throw new PlotCountError("Give the plots either as one count or as groups of sizes, not both.");
  }
  // Anything other than "none" must be a valid count, so NaN, 1.5 and 501 are
  // rejected here rather than quietly becoming an empty block.
  let groups = params.plotGroups ?? [];
  if (wantsSingle) {
    if (!params.plotUnitTypeCode) {
      throw new PlotCountError("Choose a plot type for the plots.");
    }
    groups = [{ count: params.plotCount as number, unitTypeCode: params.plotUnitTypeCode }];
  }
  for (const group of groups) {
    if (!group.unitTypeCode) throw new PlotCountError("Choose a plot type for every size.");
  }
  const rows: RawUnitRow[] = [];
  if (groups.length > 0) {
    const assigned = plotAssignments(
      params.code,
      groups.map((group) => ({ count: group.count, type: group.unitTypeCode })),
    );
    for (const { unitNumber, type } of assigned) {
      rows.push({ unitNumber, unitTypeCode: type, plcTags: [] });
    }
  }
  const byUnitType: Record<string, number> = {};
  for (const group of groups) byUnitType[group.unitTypeCode] = (byUnitType[group.unitTypeCode] ?? 0) + group.count;

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

        return { tower, plotsCreated: rows.length, byUnitType };
      },
      // Same ceiling importUnits uses: the platform's synchronous limit.
      { timeout: 10_000 },
    ),
  );
}
