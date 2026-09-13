// User/Role admin CRUD -- Phase 3.5 Slice 15 (confirmed gap: User/Role/
// RolePermission tables have been seeded and read since Phase 0, but no
// service function ever exposed managing them). Roles themselves are
// managed as org-scoped data rows created by the seed script from
// @desire/db's ROLE_CODES/PERMISSION_MATRIX (permission-matrix.ts) -- this
// file assigns EXISTING roles to users, it does not create new roles or
// edit RolePermission grants (that is a bigger, genuinely separate
// "redefine what a role can do" feature nothing in this phase's plan asks
// for).
import { randomBytes } from "node:crypto";
import { Prisma } from "@desire/db";
import type { PrismaClient, User, UserStatus } from "@desire/db";
import { type RoleCode } from "@desire/db";
export type { User };
import { hashPassword } from "./password";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const MANAGE_PERMISSION = "rbac.manage";

// ── Errors ─────────────────────────────────────────────────────────────

export class DuplicateEmailError extends Error {
  constructor(public readonly email: string) {
    super(`A user with email "${email}" already exists in this organisation.`);
    this.name = "DuplicateEmailError";
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`User ${userId} not found.`);
    this.name = "UserNotFoundError";
  }
}

export class RoleNotFoundError extends Error {
  constructor(public readonly roleCode: string) {
    super(`Role "${roleCode}" is not configured for this organisation.`);
    this.name = "RoleNotFoundError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Admin mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

// ── Read ───────────────────────────────────────────────────────────────

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  roleCodes: string[];
  lastLoginAt: string | null;
}

export async function listUsers(db: PrismaClient, params: { orgId: string; actorId: string }): Promise<UserSummary[]> {
  await assertPermission(db, params.actorId, MANAGE_PERMISSION);
  const users = await db.user.findMany({
    where: { orgId: params.orgId },
    include: { userRoles: { include: { role: { select: { code: true } } } } },
    orderBy: { email: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    roleCodes: u.userRoles.map((ur) => ur.role.code),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  }));
}

// ── Create ─────────────────────────────────────────────────────────────

export interface CreateUserParams {
  email: string;
  name: string;
  roleCode: RoleCode;
  audit: AuditContext;
}

export interface CreatedUser {
  userId: string;
  /** Shown to the admin exactly once -- this codebase has no invite-email
   *  flow, so the temporary password is the only way the new user gets
   *  in. Never persisted anywhere except as the row's argon2id hash. */
  temporaryPassword: string;
}

export async function createUser(db: PrismaClient, params: CreateUserParams): Promise<CreatedUser> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, MANAGE_PERMISSION);

    const role = await tx.role.findUnique({ where: { orgId_code: { orgId: params.audit.orgId, code: params.roleCode } } });
    if (!role) throw new RoleNotFoundError(params.roleCode);

    const temporaryPassword = randomBytes(9).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);

    let user: User;
    try {
      user = await tx.user.create({
        data: { orgId: params.audit.orgId, email: params.email, name: params.name, passwordHash, status: "INVITED" },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DuplicateEmailError(params.email);
      }
      throw err;
    }

    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null, assignedBy: actorId } });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "User",
      entityId: user.id,
      after: { email: user.email, name: user.name, roleCode: params.roleCode },
    });

    return { userId: user.id, temporaryPassword };
  });
}

// ── Update roles ───────────────────────────────────────────────────────

export interface UpdateUserRolesParams {
  userId: string;
  roleCode: RoleCode;
  audit: AuditContext;
}

/** Replaces every role assignment this user has with exactly one. Every
 *  user this codebase seeds or creates has exactly one role (seed.ts's own
 *  pattern) -- this matches that reality rather than building a multi-
 *  role-per-user UI nothing else in the app assumes or needs. */
export async function updateUserRoles(db: PrismaClient, params: UpdateUserRolesParams): Promise<void> {
  const actorId = requireActor(params.audit);

  await db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, MANAGE_PERMISSION);

    const user = await tx.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new UserNotFoundError(params.userId);
    if (user.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`User ${params.userId} belongs to another organisation.`);
    }

    const role = await tx.role.findUnique({ where: { orgId_code: { orgId: params.audit.orgId, code: params.roleCode } } });
    if (!role) throw new RoleNotFoundError(params.roleCode);

    const before = await tx.userRole.findMany({ where: { userId: user.id }, include: { role: { select: { code: true } } } });

    await tx.userRole.deleteMany({ where: { userId: user.id } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null, assignedBy: actorId } });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      before: { roleCodes: before.map((b) => b.role.code) },
      after: { roleCodes: [params.roleCode] },
    });
  });
}
