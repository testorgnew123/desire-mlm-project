// Project / tower / unit-type / unit master data (docs/03-DATA-MODEL.md,
// docs/06-INVENTORY-SPEC.md). Mechanical CRUD, with three things that are not:
//
//   1. Areas. carpet < built-up <= saleable are three DIFFERENT numbers
//      (docs/19-GLOSSARY.md). Swapping them misprices a unit by ~35% and the
//      error only surfaces after a customer has signed, so the ordering is
//      enforced at write time rather than trusted.
//   2. RERA, which is deliberately NOT checked here. The guard table in
//      docs/06-INVENTORY-SPEC.md scopes "project RERA registration valid" to
//      the AVAILABLE -> HELD transition, and holds.ts applies it there.
//      Enforcing it at creation would leave a PLANNING or PRE_LAUNCH project
//      impossible to populate -- Project.reraRegNo is nullable and
//      createProject does not ask for it -- and would disagree with
//      unit-import.ts, which inserts the same inventory with no such check.
//   3. Tenancy. orgId is taken from the audit context, never from the caller,
//      so a mutation cannot write into one org while being audited under
//      another.
import { Prisma } from "@desire/db";
import type { PrismaClient, ProjectStatus, Project, Tower, UnitType, Unit } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";
import { UnitNotFoundError } from "./holds";

/** Decimals arrive as a Decimal or a fixed-point string, never a number --
 *  binary floats cannot hold 1234.55 exactly, and an area feeds straight into
 *  a price (docs/06-INVENTORY-SPEC.md section 5). */
export type DecimalInput = Prisma.Decimal | string;

// ── Errors ─────────────────────────────────────────────────────────────

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = "ProjectNotFoundError";
  }
}

export class TowerNotFoundError extends Error {
  constructor(towerId: string) {
    super(`Tower ${towerId} not found.`);
    this.name = "TowerNotFoundError";
  }
}

export class UnitTypeNotFoundError extends Error {
  constructor(unitTypeId: string) {
    super(`Unit type ${unitTypeId} not found.`);
    this.name = "UnitTypeNotFoundError";
  }
}

/** One class for every (parent, code) uniqueness violation -- the UI renders
 *  them identically as a field-level message, and a 500 for a typed duplicate
 *  code would be a bad error shape (docs/07-API.md).
 *
 *  `field` names the offending input ("Project code", "Unit number") so the
 *  message reads correctly for both. */
export class DuplicateCodeError extends Error {
  constructor(
    public readonly field: string,
    public readonly code: string,
  ) {
    super(`${field} "${code}" is already in use.`);
    this.name = "DuplicateCodeError";
  }
}

/** The expensive data-entry mistake this domain is prone to. Carries all three
 *  figures so the message can show what was actually submitted. */
export class InvalidUnitAreasError extends Error {
  constructor(
    public readonly carpetArea: Prisma.Decimal,
    public readonly builtUpArea: Prisma.Decimal,
    public readonly saleableArea: Prisma.Decimal,
    detail: string,
  ) {
    super(
      `${detail} (carpet ${carpetArea.toFixed(2)}, built-up ${builtUpArea.toFixed(2)}, ` +
        `saleable ${saleableArea.toFixed(2)}).`,
    );
    this.name = "InvalidUnitAreasError";
  }
}

export class InvalidHoldPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHoldPolicyError";
  }
}

/** Nothing in this file throws this -- see the note on RERA in the file
 *  header. Kept exported because unit-import.ts imports it; the two should be
 *  removed together if that import is ever dropped. */
export class ProjectReraInvalidError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} has no valid RERA registration; units cannot be created.`);
    this.name = "ProjectReraInvalidError";
  }
}

/** A unit pointing at another project's tower or unit type would resolve the
 *  wrong areas and therefore the wrong price, silently. Prisma's foreign keys
 *  cannot express "and it must belong to the same project". */
export class CrossProjectReferenceError extends Error {
  constructor(entity: string, id: string, projectId: string) {
    super(`${entity} ${id} does not belong to project ${projectId}.`);
    this.name = "CrossProjectReferenceError";
  }
}

// ── Areas ──────────────────────────────────────────────────────────────

export interface UnitTypeAreas {
  carpetArea: Prisma.Decimal;
  builtUpArea: Prisma.Decimal;
  saleableArea: Prisma.Decimal;
}

export interface UnitAreaOverrides {
  carpetAreaOverride: Prisma.Decimal | null;
  saleableAreaOverride: Prisma.Decimal | null;
}

/** Effective areas for one unit. Null override means inherit from the unit
 *  type (schema comment on Unit.carpetAreaOverride). There is deliberately no
 *  built-up override column, so built-up always comes from the type -- callers
 *  that need it per unit should be asking for carpet or saleable instead
 *  (docs/19-GLOSSARY.md: built-up is legacy, nothing is priced on it).
 *
 *  Pure and DB-free so cost-sheet code can call it on rows it already holds. */
export function resolveUnitAreas(unit: UnitAreaOverrides, unitType: UnitTypeAreas): UnitTypeAreas {
  return {
    carpetArea: unit.carpetAreaOverride ?? unitType.carpetArea,
    builtUpArea: unitType.builtUpArea,
    saleableArea: unit.saleableAreaOverride ?? unitType.saleableArea,
  };
}

/** Rounds to the 2dp the columns actually store, half-up, before anything is
 *  compared or written. Validating at full input precision and letting
 *  Postgres round afterwards could store carpet == built-up while the check
 *  saw carpet < built-up. */
function toArea(value: DecimalInput): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Tri-state patch of a nullable area override: undefined leaves it alone,
 *  null clears it back to inheriting from the unit type, a value sets it. */
function patchOverride(
  patch: DecimalInput | null | undefined,
  current: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (patch === undefined) return current;
  return patch === null ? null : toArea(patch);
}

/** carpet < built-up <= saleable. Built-up is carpet plus internal walls and
 *  balcony, so it is strictly larger; saleable adds a share of common areas
 *  and may equal built-up when the loading factor is zero
 *  (docs/19-GLOSSARY.md). */
function assertAreaHierarchy(areas: UnitTypeAreas): void {
  const { carpetArea, builtUpArea, saleableArea } = areas;
  if (!carpetArea.gt(0) || !builtUpArea.gt(0) || !saleableArea.gt(0)) {
    throw new InvalidUnitAreasError(carpetArea, builtUpArea, saleableArea, "Areas must be positive");
  }
  if (!carpetArea.lt(builtUpArea)) {
    throw new InvalidUnitAreasError(
      carpetArea,
      builtUpArea,
      saleableArea,
      "Carpet area must be less than built-up area",
    );
  }
  if (builtUpArea.gt(saleableArea)) {
    throw new InvalidUnitAreasError(
      carpetArea,
      builtUpArea,
      saleableArea,
      "Built-up area must not exceed saleable area",
    );
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────

/** Master data is only ever changed by a person. AuditContext.actorId is
 *  nullable for job actors (the hold-expiry sweep), and a job has no roles to
 *  check, so a null actor here is an authorization failure rather than a
 *  missing-argument bug. */
function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Master-data mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

/** Decimal and Date do not survive a JSON column as themselves. Fixed-point
 *  strings and ISO 8601 match what the API emits (docs/07-API.md), so an audit
 *  row reads back as exactly the value that was stored. */
function toAuditValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function auditSnapshot(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = toAuditValue(value);
  return out;
}

/** before/after limited to the keys actually being written, so an audit row
 *  for a one-field edit is readable rather than a full row dump. */
function auditDiff(
  existing: object,
  patch: object,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const current = existing as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(patch)) {
    before[key] = toAuditValue(current[key]);
    after[key] = toAuditValue(next);
  }
  return { before, after };
}

/** Turns the (parent, code) unique-constraint violation into DuplicateCodeError
 *  wherever a code or unit number is written. */
async function withUniqueCode<T>(field: string, code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DuplicateCodeError(field, code);
    }
    throw err;
  }
}

/** Loads the project and proves it belongs to the acting org before anything
 *  else reads or writes through it. */
async function loadProjectInOrg(
  tx: Prisma.TransactionClient,
  projectId: string,
  orgId: string,
): Promise<{ id: string; orgId: string }> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true },
  });
  if (!project) throw new ProjectNotFoundError(projectId);
  if (project.orgId !== orgId) {
    throw new ForbiddenError(`Project ${projectId} belongs to another organisation.`);
  }
  return project;
}

/** A non-positive TTL mints holds that are already expired: the lazy-expiry
 *  reader in holds.ts would treat the unit as available the instant it was
 *  held (docs/06-INVENTORY-SPEC.md section 3). */
function assertHoldPolicy(policy: {
  holdTtlMinutes?: number;
  holdExtensionMinutes?: number;
  maxHoldExtensions?: number;
}): void {
  if (policy.holdTtlMinutes !== undefined && policy.holdTtlMinutes <= 0) {
    throw new InvalidHoldPolicyError("holdTtlMinutes must be greater than zero.");
  }
  if (policy.holdExtensionMinutes !== undefined && policy.holdExtensionMinutes <= 0) {
    throw new InvalidHoldPolicyError("holdExtensionMinutes must be greater than zero.");
  }
  if (policy.maxHoldExtensions !== undefined && policy.maxHoldExtensions < 0) {
    throw new InvalidHoldPolicyError("maxHoldExtensions cannot be negative.");
  }
}

// ── Project ────────────────────────────────────────────────────────────

export interface CreateProjectParams {
  code: string;
  name: string;
  status?: ProjectStatus;

  reraRegNo?: string | null;
  reraValidTill?: Date | null;
  reraPortalUrl?: string | null;

  addressLine1?: string | null;
  addressLine2?: string | null;
  city: string;
  state: string;
  pincode?: string | null;
  latitude?: DecimalInput | null;
  longitude?: DecimalInput | null;

  launchDate?: Date | null;
  expectedPossessionDate?: Date | null;

  holdTtlMinutes?: number;
  holdExtensionMinutes?: number;
  maxHoldExtensions?: number;
  holdRequiresApproval?: boolean;

  audit: AuditContext;
}

export async function createProject(db: PrismaClient, params: CreateProjectParams): Promise<Project> {
  const actorId = requireActor(params.audit);
  assertHoldPolicy(params);

  return withUniqueCode("Project code", params.code, () =>
    db.$transaction(async (tx) => {
      // No projectId to scope against yet, so only an org-wide grant of
      // project.write qualifies -- a Project Manager scoped to one project
      // must not be able to conjure another (docs/09-RBAC-MATRIX.md).
      await assertPermission(tx, actorId, "project.write");

      const data = {
        orgId: params.audit.orgId,
        code: params.code,
        name: params.name,
        status: params.status,
        reraRegNo: params.reraRegNo,
        reraValidTill: params.reraValidTill,
        reraPortalUrl: params.reraPortalUrl,
        addressLine1: params.addressLine1,
        addressLine2: params.addressLine2,
        city: params.city,
        state: params.state,
        pincode: params.pincode,
        latitude: params.latitude === null || params.latitude === undefined
          ? params.latitude
          : new Prisma.Decimal(params.latitude),
        longitude: params.longitude === null || params.longitude === undefined
          ? params.longitude
          : new Prisma.Decimal(params.longitude),
        launchDate: params.launchDate,
        expectedPossessionDate: params.expectedPossessionDate,
        holdTtlMinutes: params.holdTtlMinutes,
        holdExtensionMinutes: params.holdExtensionMinutes,
        maxHoldExtensions: params.maxHoldExtensions,
        holdRequiresApproval: params.holdRequiresApproval,
      } satisfies Prisma.ProjectUncheckedCreateInput;

      const project = await tx.project.create({ data });
      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "Project",
        entityId: project.id,
        after: auditSnapshot(data),
      });
      return project;
    }),
  );
}

/** `code` is deliberately absent: it is the project's stable external
 *  identifier, quoted in RERA filings and every export, and renaming it would
 *  silently orphan those references. */
export interface UpdateProjectParams {
  projectId: string;
  name?: string;
  status?: ProjectStatus;

  reraRegNo?: string | null;
  reraValidTill?: Date | null;
  reraPortalUrl?: string | null;

  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  pincode?: string | null;
  latitude?: DecimalInput | null;
  longitude?: DecimalInput | null;

  launchDate?: Date | null;
  expectedPossessionDate?: Date | null;

  holdTtlMinutes?: number;
  holdExtensionMinutes?: number;
  maxHoldExtensions?: number;
  holdRequiresApproval?: boolean;

  reason?: string;
  audit: AuditContext;
}

export async function updateProject(db: PrismaClient, params: UpdateProjectParams): Promise<Project> {
  const actorId = requireActor(params.audit);
  assertHoldPolicy(params);

  return db.$transaction(async (tx) => {
    // Lock before the read, the same order price-lists.ts lockProject and
    // units.ts blockUnit use. A read-modify-write on an unlocked row lets a
    // concurrent update commit between the findUnique and the update, which
    // both loses that writer's field and makes auditDiff record a `before`
    // that was never the immediately-prior state.
    await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${params.projectId} FOR UPDATE`;

    const existing = await tx.project.findUnique({ where: { id: params.projectId } });
    if (!existing) throw new ProjectNotFoundError(params.projectId);
    if (existing.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Project ${params.projectId} belongs to another organisation.`);
    }
    await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

    const data: Prisma.ProjectUncheckedUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.status !== undefined) data.status = params.status;
    if (params.reraRegNo !== undefined) data.reraRegNo = params.reraRegNo;
    if (params.reraValidTill !== undefined) data.reraValidTill = params.reraValidTill;
    if (params.reraPortalUrl !== undefined) data.reraPortalUrl = params.reraPortalUrl;
    if (params.addressLine1 !== undefined) data.addressLine1 = params.addressLine1;
    if (params.addressLine2 !== undefined) data.addressLine2 = params.addressLine2;
    if (params.city !== undefined) data.city = params.city;
    if (params.state !== undefined) data.state = params.state;
    if (params.pincode !== undefined) data.pincode = params.pincode;
    if (params.latitude !== undefined) {
      data.latitude = params.latitude === null ? null : new Prisma.Decimal(params.latitude);
    }
    if (params.longitude !== undefined) {
      data.longitude = params.longitude === null ? null : new Prisma.Decimal(params.longitude);
    }
    if (params.launchDate !== undefined) data.launchDate = params.launchDate;
    if (params.expectedPossessionDate !== undefined) {
      data.expectedPossessionDate = params.expectedPossessionDate;
    }
    if (params.holdTtlMinutes !== undefined) data.holdTtlMinutes = params.holdTtlMinutes;
    if (params.holdExtensionMinutes !== undefined) {
      data.holdExtensionMinutes = params.holdExtensionMinutes;
    }
    if (params.maxHoldExtensions !== undefined) data.maxHoldExtensions = params.maxHoldExtensions;
    if (params.holdRequiresApproval !== undefined) {
      data.holdRequiresApproval = params.holdRequiresApproval;
    }

    // Nothing submitted changed anything. An audit row here would say "someone
    // saved the form" -- noise in a trail that is read to answer "who changed
    // this field".
    if (Object.keys(data).length === 0) return existing;

    const project = await tx.project.update({ where: { id: params.projectId }, data });
    const { before, after } = auditDiff(existing, data);
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Project",
      entityId: project.id,
      before,
      after,
      reason: params.reason,
    });
    return project;
  });
}

// ── Tower ──────────────────────────────────────────────────────────────

export interface CreateTowerParams {
  projectId: string;
  code: string;
  name: string;
  totalFloors: number;
  unitsPerFloor?: number | null;
  phase?: string | null;
  displayOrder?: number;
  audit: AuditContext;
}

export async function createTower(db: PrismaClient, params: CreateTowerParams): Promise<Tower> {
  const actorId = requireActor(params.audit);

  return withUniqueCode("Tower code", params.code, () =>
    db.$transaction(async (tx) => {
      const project = await loadProjectInOrg(tx, params.projectId, params.audit.orgId);
      await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

      const data = {
        orgId: project.orgId,
        projectId: params.projectId,
        code: params.code,
        name: params.name,
        totalFloors: params.totalFloors,
        unitsPerFloor: params.unitsPerFloor,
        phase: params.phase,
        displayOrder: params.displayOrder,
      } satisfies Prisma.TowerUncheckedCreateInput;

      const tower = await tx.tower.create({ data });
      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "Tower",
        entityId: tower.id,
        after: auditSnapshot(data),
      });
      return tower;
    }),
  );
}

// ── Unit type ──────────────────────────────────────────────────────────

export interface CreateUnitTypeParams {
  projectId: string;
  code: string;
  name: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  balconies?: number | null;
  carpetArea: DecimalInput;
  builtUpArea: DecimalInput;
  saleableArea: DecimalInput;
  terraceArea?: DecimalInput | null;
  floorPlanUrl?: string | null;
  audit: AuditContext;
}

export async function createUnitType(
  db: PrismaClient,
  params: CreateUnitTypeParams,
): Promise<UnitType> {
  const actorId = requireActor(params.audit);

  const areas: UnitTypeAreas = {
    carpetArea: toArea(params.carpetArea),
    builtUpArea: toArea(params.builtUpArea),
    saleableArea: toArea(params.saleableArea),
  };
  assertAreaHierarchy(areas);

  return withUniqueCode("Unit type code", params.code, () =>
    db.$transaction(async (tx) => {
      const project = await loadProjectInOrg(tx, params.projectId, params.audit.orgId);
      await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

      const data = {
        orgId: project.orgId,
        projectId: params.projectId,
        code: params.code,
        name: params.name,
        bedrooms: params.bedrooms,
        bathrooms: params.bathrooms,
        balconies: params.balconies,
        carpetArea: areas.carpetArea,
        builtUpArea: areas.builtUpArea,
        saleableArea: areas.saleableArea,
        terraceArea:
          params.terraceArea === null || params.terraceArea === undefined
            ? params.terraceArea
            : toArea(params.terraceArea),
        floorPlanUrl: params.floorPlanUrl,
      } satisfies Prisma.UnitTypeUncheckedCreateInput;

      const unitType = await tx.unitType.create({ data });
      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "UnitType",
        entityId: unitType.id,
        after: auditSnapshot(data),
      });
      return unitType;
    }),
  );
}

// ── Unit ───────────────────────────────────────────────────────────────

export interface CreateUnitParams {
  projectId: string;
  towerId?: string | null;
  unitTypeId: string;
  unitNumber: string;
  floor: number;
  facing?: string | null;
  plcTags?: string[];
  /** Null or omitted means inherit from the unit type. */
  carpetAreaOverride?: DecimalInput | null;
  saleableAreaOverride?: DecimalInput | null;
  audit: AuditContext;
}

/** A unit is always born AVAILABLE -- there is no `status` parameter, because
 *  every other status is reachable only through the guarded transitions in
 *  units.ts / holds.ts (docs/06-INVENTORY-SPEC.md section 1). Seeding a unit
 *  straight into BOOKED would skip the history row that makes a sale
 *  explainable. */
export async function createUnit(db: PrismaClient, params: CreateUnitParams): Promise<Unit> {
  const actorId = requireActor(params.audit);

  return withUniqueCode("Unit number", params.unitNumber, () =>
    db.$transaction(async (tx) => {
      const project = await loadProjectInOrg(tx, params.projectId, params.audit.orgId);
      await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

      const unitType = await loadUnitTypeInProject(tx, params.unitTypeId, params.projectId);
      if (params.towerId) await assertTowerInProject(tx, params.towerId, params.projectId);

      const overrides: UnitAreaOverrides = {
        carpetAreaOverride: patchOverride(params.carpetAreaOverride, null),
        saleableAreaOverride: patchOverride(params.saleableAreaOverride, null),
      };
      assertAreaHierarchy(resolveUnitAreas(overrides, unitType));

      const data = {
        orgId: project.orgId,
        projectId: params.projectId,
        towerId: params.towerId,
        unitTypeId: params.unitTypeId,
        unitNumber: params.unitNumber,
        floor: params.floor,
        facing: params.facing,
        plcTags: params.plcTags ?? [],
        carpetAreaOverride: overrides.carpetAreaOverride,
        saleableAreaOverride: overrides.saleableAreaOverride,
      } satisfies Prisma.UnitUncheckedCreateInput;

      const unit = await tx.unit.create({ data });

      // Genesis history row. UnitStatusHistory.fromStatus is nullable precisely
      // for this, and unblockUnit in units.ts reads history to find a unit's
      // prior status -- a unit with no history at all has a hole in that trail.
      await tx.unitStatusHistory.create({
        data: {
          unitId: unit.id,
          fromStatus: null,
          toStatus: "AVAILABLE",
          reason: "unit created",
          actorId: params.audit.actorId,
          actorLabel: params.audit.actorLabel,
        },
      });

      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "Unit",
        entityId: unit.id,
        after: auditSnapshot(data),
      });
      return unit;
    }),
  );
}

/** `status`, `blockReason` and `currentHoldId` are absent on purpose: status is
 *  owned by transitionUnitStatus / blockUnit in units.ts, which write the
 *  UnitStatusHistory row that goes with it, and currentHoldId is owned by
 *  holds.ts under a row lock. A generic patch on those fields would bypass both. */
export interface UpdateUnitParams {
  unitId: string;
  towerId?: string | null;
  unitTypeId?: string;
  unitNumber?: string;
  floor?: number;
  facing?: string | null;
  plcTags?: string[];
  /** Explicit null clears the override, so the unit inherits from its type
   *  again; omitting the key leaves the current override untouched. */
  carpetAreaOverride?: DecimalInput | null;
  saleableAreaOverride?: DecimalInput | null;
  reason?: string;
  audit: AuditContext;
}

export async function updateUnit(db: PrismaClient, params: UpdateUnitParams): Promise<Unit> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    // Lock before the read, as holds.ts acquireHold and units.ts blockUnit do
    // on this same row. assertAreaHierarchy below validates the patch against
    // the row read here, so without the lock one transaction repointing
    // unitTypeId and another setting carpetAreaOverride each pass on data the
    // other has not committed yet, and the row that lands can have carpet
    // above built-up -- the inverted-area mispricing the file header calls out.
    // The write lock Postgres takes on UPDATE is too late to help: the
    // validation and the audit `before` snapshot have already run on the stale
    // read.
    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${params.unitId} FOR UPDATE`;

    const existing = await tx.unit.findUnique({ where: { id: params.unitId } });
    if (!existing) throw new UnitNotFoundError(params.unitId);

    const projectId = existing.projectId;
    await loadProjectInOrg(tx, projectId, params.audit.orgId);
    await assertPermission(tx, actorId, "project.write", { projectId });

    const overrides: UnitAreaOverrides = {
      carpetAreaOverride: patchOverride(params.carpetAreaOverride, existing.carpetAreaOverride),
      saleableAreaOverride: patchOverride(params.saleableAreaOverride, existing.saleableAreaOverride),
    };

    const data: Prisma.UnitUncheckedUpdateInput = {};
    if (params.towerId !== undefined) data.towerId = params.towerId;
    if (params.unitTypeId !== undefined) data.unitTypeId = params.unitTypeId;
    if (params.unitNumber !== undefined) data.unitNumber = params.unitNumber;
    if (params.floor !== undefined) data.floor = params.floor;
    if (params.facing !== undefined) data.facing = params.facing;
    if (params.plcTags !== undefined) data.plcTags = params.plcTags;
    if (params.carpetAreaOverride !== undefined) {
      data.carpetAreaOverride = overrides.carpetAreaOverride;
    }
    if (params.saleableAreaOverride !== undefined) {
      data.saleableAreaOverride = overrides.saleableAreaOverride;
    }

    if (Object.keys(data).length === 0) return existing;

    // Validate against the type the unit will have once this patch lands, not
    // the one it has now -- repointing a unit at a different type inverts
    // carpet and saleable just as easily as editing an override does.
    const unitType = await loadUnitTypeInProject(
      tx,
      params.unitTypeId ?? existing.unitTypeId,
      projectId,
    );
    if (params.towerId) await assertTowerInProject(tx, params.towerId, projectId);
    assertAreaHierarchy(resolveUnitAreas(overrides, unitType));

    const unit = await withUniqueCode("Unit number", params.unitNumber ?? existing.unitNumber, () =>
      tx.unit.update({ where: { id: params.unitId }, data }),
    );
    const { before, after } = auditDiff(existing, data);
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Unit",
      entityId: unit.id,
      before,
      after,
      reason: params.reason,
    });
    return unit;
  });
}

async function loadUnitTypeInProject(
  tx: Prisma.TransactionClient,
  unitTypeId: string,
  projectId: string,
): Promise<UnitTypeAreas> {
  const unitType = await tx.unitType.findUnique({
    where: { id: unitTypeId },
    select: { projectId: true, carpetArea: true, builtUpArea: true, saleableArea: true },
  });
  if (!unitType) throw new UnitTypeNotFoundError(unitTypeId);
  if (unitType.projectId !== projectId) {
    throw new CrossProjectReferenceError("Unit type", unitTypeId, projectId);
  }
  return {
    carpetArea: unitType.carpetArea,
    builtUpArea: unitType.builtUpArea,
    saleableArea: unitType.saleableArea,
  };
}

async function assertTowerInProject(
  tx: Prisma.TransactionClient,
  towerId: string,
  projectId: string,
): Promise<void> {
  const tower = await tx.tower.findUnique({ where: { id: towerId }, select: { projectId: true } });
  if (!tower) throw new TowerNotFoundError(towerId);
  if (tower.projectId !== projectId) {
    throw new CrossProjectReferenceError("Tower", towerId, projectId);
  }
}
