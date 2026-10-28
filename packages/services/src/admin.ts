// User/Role admin CRUD -- Phase 3.5 Slice 15 (confirmed gap: User/Role/
// RolePermission tables have been seeded and read since Phase 0, but no
// service function ever exposed managing them). Roles themselves are
// managed as org-scoped data rows created by the seed script from
// @desire/db's ROLE_CODES/PERMISSION_MATRIX (permission-matrix.ts) -- this
// file assigns EXISTING roles to users, it does not create new roles or
// edit RolePermission grants (that is a bigger, genuinely separate
// "redefine what a role can do" feature nothing in this phase's plan asks
// for).
//
// Three roles exist (SUPER_ADMIN, ADMIN, ASSOCIATE) and two permissions govern
// who may manage accounts:
//   - user.manage  (SUPER_ADMIN, ADMIN): enough to manage ASSOCIATE accounts;
//   - rbac.manage  (SUPER_ADMIN only): needed for anything that touches an
//     ADMIN or SUPER_ADMIN account, or assigns one of those roles.
// So an ADMIN can create and look after associates but can never mint, promote
// or alter another admin.
import { randomBytes } from "node:crypto";
import { Prisma } from "@desire/db";
import type { PrismaClient, User, UserStatus } from "@desire/db";
import { ROLE_CODES, type RoleCode } from "@desire/db";
export type { User };
export { NoDefaultGradeError, ensureAssociateProfile } from "./associate-profile";
export type { EnsuredAssociate } from "./associate-profile";
import { sendCredentialsEmail } from "./account-mail";
import { hashPassword } from "./password";
import { writeAuditLog, type AuditContext } from "./audit";
import {
  ROLES_THAT_SELL,
  ensureAdminAssociateProfile,
  ensureAssociateProfile,
} from "./associate-profile";
import { revokeAllSessions } from "./auth";
import { ForbiddenError, getSessionPermissions } from "./rbac";

const MANAGE_USERS = "user.manage";
const MANAGE_RBAC = "rbac.manage";
const ASSOCIATE_ROLE: RoleCode = "ASSOCIATE";
const SUPER_ADMIN_ROLE: RoleCode = "SUPER_ADMIN";

/** More than a page of accounts is not something this screen is built for;
 *  anything past it would silently disappear, so it is a named ceiling rather
 *  than an unbounded read. */
const USER_LIST_LIMIT = 500;

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
    super(
      `Role "${roleCode}" is not configured for this organisation. Roles are added by the role sync that ` +
        "runs on every deploy (pnpm db:sync-roles); it has not reached this database yet.",
    );
    this.name = "RoleNotFoundError";
  }
}

/** The posted role is not one of the three that exist. The admin actions only
 *  cast the form value, so this is the real check. */
export class InvalidRoleError extends Error {
  constructor(public readonly roleCode: string) {
    super(`"${roleCode}" is not a role. Choose one of: ${ROLE_CODES.join(", ")}.`);
    this.name = "InvalidRoleError";
  }
}

export class InvalidUserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUserInputError";
  }
}

export class SelfRoleChangeError extends Error {
  constructor() {
    super("You cannot change your own role.");
    this.name = "SelfRoleChangeError";
  }
}

export class LastSuperAdminError extends Error {
  constructor() {
    super("This is the last Super Admin; the organisation must keep at least one.");
    this.name = "LastSuperAdminError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Admin mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

function assertRoleCode(roleCode: string): asserts roleCode is RoleCode {
  if (!(ROLE_CODES as readonly string[]).includes(roleCode)) throw new InvalidRoleError(roleCode);
}

/** What the actor may do to accounts, from one permission read. */
async function actorReach(
  db: PrismaClient | Prisma.TransactionClient,
  actorId: string,
): Promise<{ users: boolean; rbac: boolean }> {
  const codes = await getSessionPermissions(db, actorId);
  const rbac = codes.has(MANAGE_RBAC);
  return { users: rbac || codes.has(MANAGE_USERS), rbac };
}

/** The privilege ceiling. `roleCodes` is every role the change touches: the
 *  target's current roles AND the role being assigned. */
async function assertCanManage(
  db: PrismaClient | Prisma.TransactionClient,
  actorId: string,
  roleCodes: readonly string[],
): Promise<void> {
  const reach = await actorReach(db, actorId);
  if (!reach.users) throw new ForbiddenError(`User ${actorId} lacks permission "${MANAGE_USERS}".`);
  if (!reach.rbac && roleCodes.some((code) => code !== ASSOCIATE_ROLE)) {
    throw new ForbiddenError("Only a Super Admin can manage admins and super admins.");
  }
}

function normaliseEmail(email: string): string {
  const value = email.trim().toLowerCase();
  // Login lowercases what it is given, so an address stored with capitals could
  // never be matched again.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new InvalidUserInputError(`"${email}" is not a valid email address.`);
  return value;
}

// ── Associate profile ──────────────────────────────────────────────────

/** An associate always gets a profile (and fails without a grade to put them
 *  under). An Admin or Super Admin gets one too, because they hold and book plots
 *  as well, but without a grade the account is still made and they simply cannot
 *  hold yet. */
async function ensureProfileFor(
  tx: Prisma.TransactionClient,
  roleCode: RoleCode,
  userId: string,
  audit: AuditContext,
): Promise<{ code: string } | null> {
  if (roleCode === ASSOCIATE_ROLE) return ensureAssociateProfile(tx, { userId, audit });
  if (ROLES_THAT_SELL.includes(roleCode)) return ensureAdminAssociateProfile(tx, { userId, audit });
  return null;
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

/** What the actor may manage: everyone for a Super Admin, only associates for an
 *  Admin. Only the columns the screen draws are read -- this used to return
 *  whole User rows, password hash and MFA secret included. */
export async function listUsers(
  db: PrismaClient,
  params: {
    orgId: string;
    actorId: string;
    /** Rows to skip, for paging. Ordered by email, which is unique per org, so pages never overlap. */
    skip?: number;
    /** Rows to return. Ask for one more than a page to learn whether there is a next one. */
    take?: number;
  },
): Promise<UserSummary[]> {
  const reach = await actorReach(db, params.actorId);
  if (!reach.users) throw new ForbiddenError(`User ${params.actorId} lacks permission "${MANAGE_USERS}".`);

  const users = await db.user.findMany({
    where: {
      orgId: params.orgId,
      ...(reach.rbac
        ? {}
        : { userRoles: { some: { role: { code: ASSOCIATE_ROLE } }, none: { role: { code: { not: ASSOCIATE_ROLE } } } } }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      lastLoginAt: true,
      userRoles: { select: { role: { select: { code: true } } } },
    },
    orderBy: { email: "asc" },
    skip: params.skip,
    take: Math.min(params.take ?? USER_LIST_LIMIT, USER_LIST_LIMIT),
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

/** What an account-creating or password-resetting action hands back. The
 *  temporary password is returned so the admin can pass it on when the email did
 *  not go; when it did, the screen does not show it. */
export interface IssuedCredentials {
  userId: string;
  /** Normalised (trimmed, lower-case): what the person types to sign in. */
  email: string;
  /** Never persisted anywhere except as the row's argon2id hash. */
  temporaryPassword: string;
  emailSent: boolean;
  /** Why the email did not go, when it did not. */
  emailNote: string | null;
}

export interface CreatedUser extends IssuedCredentials {
  /** Set when the new user is an associate. */
  associateCode: string | null;
}

function newTemporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}

/** Creates the account, then -- only after the transaction has committed --
 *  emails the login ID and temporary password. A mail server that is down must
 *  not undo an account that exists, so the email is outside the transaction and
 *  its failure is reported, not thrown. The person must replace the temporary
 *  password at first sign-in (mustChangePassword). */
export async function createUser(db: PrismaClient, params: CreateUserParams): Promise<CreatedUser> {
  const actorId = requireActor(params.audit);
  assertRoleCode(params.roleCode);
  const email = normaliseEmail(params.email);
  const name = params.name.trim();
  if (name === "") throw new InvalidUserInputError("A name is required.");

  // Hashed before the transaction opens: argon2 is deliberately slow, and a
  // transaction holds a connection (and any locks) for as long as it runs.
  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const created = await db.$transaction(async (tx) => {
    await assertCanManage(tx, actorId, [params.roleCode]);

    const role = await tx.role.findUnique({ where: { orgId_code: { orgId: params.audit.orgId, code: params.roleCode } } });
    if (!role) throw new RoleNotFoundError(params.roleCode);

    let user: User;
    try {
      user = await tx.user.create({
        data: { orgId: params.audit.orgId, email, name, passwordHash, status: "INVITED", mustChangePassword: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DuplicateEmailError(email);
      }
      throw err;
    }

    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null, assignedBy: actorId } });

    const associate = await ensureProfileFor(tx, params.roleCode, user.id, params.audit);

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "User",
      entityId: user.id,
      after: { email: user.email, name: user.name, roleCode: params.roleCode },
    });

    // The code is reported (and mailed) for an associate account only: an admin's
    // profile is there so they can hold and book, not something to tell them about.
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      associateCode: params.roleCode === ASSOCIATE_ROLE ? (associate?.code ?? null) : null,
    };
  });

  const mail = await sendCredentialsEmail({
    to: created.email,
    name: created.name,
    loginId: created.email,
    temporaryPassword,
    associateCode: created.associateCode,
    kind: "created",
  });

  return {
    userId: created.userId,
    email: created.email,
    temporaryPassword,
    associateCode: created.associateCode,
    emailSent: mail.sent,
    emailNote: mail.note,
  };
}

// ── Reset a password ───────────────────────────────────────────────────

export interface ResetUserPasswordParams {
  userId: string;
  audit: AuditContext;
}

/** An administrator sets a new temporary password for someone who is locked out
 *  or has forgotten theirs. Same ceiling as everything else here: an ADMIN can
 *  do it for associates, only a SUPER_ADMIN for anyone. It ends every session,
 *  clears a lockout, makes the person choose their own password at next sign-in,
 *  voids any pending reset link, and emails the new credentials. */
export async function resetUserPassword(db: PrismaClient, params: ResetUserPasswordParams): Promise<IssuedCredentials> {
  const actorId = requireActor(params.audit);

  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const target = await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: params.userId },
      select: { id: true, orgId: true, email: true, name: true, userRoles: { select: { role: { select: { code: true } } } } },
    });
    if (!user) throw new UserNotFoundError(params.userId);
    if (user.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`User ${params.userId} belongs to another organisation.`);
    }
    await assertCanManage(tx, actorId, user.userRoles.map((ur) => ur.role.code));

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await revokeAllSessions(tx, user.id);
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      after: { passwordReset: "by administrator" },
    });
    return { id: user.id, email: user.email, name: user.name };
  });

  const mail = await sendCredentialsEmail({
    to: target.email,
    name: target.name,
    loginId: target.email,
    temporaryPassword,
    kind: "reset",
  });

  return {
    userId: target.id,
    email: target.email,
    temporaryPassword,
    emailSent: mail.sent,
    emailNote: mail.note,
  };
}

// ── Update roles ───────────────────────────────────────────────────────

export interface UpdateUserRolesParams {
  userId: string;
  roleCode: RoleCode;
  audit: AuditContext;
}

/** Replaces every role assignment this user has with exactly one. Every user
 *  this codebase seeds or creates has exactly one role (seed.ts's own
 *  pattern) -- this matches that reality rather than building a multi-
 *  role-per-user UI nothing else in the app assumes or needs.
 *
 *  A real change revokes every session of the user (docs/10-SECURITY.md), so a
 *  demoted account cannot carry on with the permissions it just lost. */
export async function updateUserRoles(db: PrismaClient, params: UpdateUserRolesParams): Promise<void> {
  const actorId = requireActor(params.audit);
  assertRoleCode(params.roleCode);

  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new UserNotFoundError(params.userId);
    if (user.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`User ${params.userId} belongs to another organisation.`);
    }

    const before = await tx.userRole.findMany({ where: { userId: user.id }, include: { role: { select: { code: true } } } });
    const beforeCodes = before.map((b) => b.role.code);

    await assertCanManage(tx, actorId, [...beforeCodes, params.roleCode]);
    if (user.id === actorId) throw new SelfRoleChangeError();

    const role = await tx.role.findUnique({ where: { orgId_code: { orgId: params.audit.orgId, code: params.roleCode } } });
    if (!role) throw new RoleNotFoundError(params.roleCode);

    const unchanged = beforeCodes.length === 1 && beforeCodes[0] === params.roleCode;
    if (unchanged) return;

    if (beforeCodes.includes(SUPER_ADMIN_ROLE) && params.roleCode !== SUPER_ADMIN_ROLE) {
      const others = await tx.user.count({
        where: { orgId: params.audit.orgId, id: { not: user.id }, userRoles: { some: { role: { code: SUPER_ADMIN_ROLE } } } },
      });
      if (others === 0) throw new LastSuperAdminError();
    }

    await tx.userRole.deleteMany({ where: { userId: user.id } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null, assignedBy: actorId } });
    await ensureProfileFor(tx, params.roleCode, user.id, params.audit);
    await revokeAllSessions(tx, user.id);

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      before: { roleCodes: beforeCodes },
      after: { roleCodes: [params.roleCode] },
    });
  });
}
