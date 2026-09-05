-- GATE (docs/02-ARCHITECTURE.md, docs/06-INVENTORY-SPEC.md, PROGRESS.md Phase 0).
--
-- Prisma cannot express a partial unique index (a UNIQUE constraint with a
-- WHERE clause), so these three are hand-written. Each is a correctness
-- guarantee, not an optimisation:
--
--   one_active_hold_per_unit
--     Without it, two associates tapping "Hold" on the same unit in the same
--     second both succeed. This is the single most important index in the
--     schema -- see docs/06-INVENTORY-SPEC.md section 2.
--
--   user_role_org_wide / user_role_scoped
--     Postgres treats NULLs as distinct, so a plain UNIQUE(userId, roleId,
--     projectId) would silently allow the same org-wide role (projectId
--     NULL) to be granted to a user twice. Split into two partial indexes: one
--     for the org-wide case (projectId IS NULL) and one for the
--     project-scoped case (projectId IS NOT NULL).
--
-- NOTE ON QUOTING: no model in schema.prisma sets a per-field @map, so Prisma
-- keeps column names exactly as written in the schema -- camelCase, not
-- snake_case. Every identifier below must be double-quoted or Postgres will
-- lowercase-fold it and fail to find the column ("releasedat" != "releasedAt").
--
-- A test in packages/db/test/partial-indexes.test.ts asserts all three exist.
-- If a future migration or a stray `prisma db push` ever drops one, that test
-- must fail -- production must never discover this silently.

CREATE UNIQUE INDEX "one_active_hold_per_unit"
  ON "unit_holds" ("unitId")
  WHERE "releasedAt" IS NULL;

CREATE UNIQUE INDEX "user_role_org_wide"
  ON "user_roles" ("userId", "roleId")
  WHERE "projectId" IS NULL;

CREATE UNIQUE INDEX "user_role_scoped"
  ON "user_roles" ("userId", "roleId", "projectId")
  WHERE "projectId" IS NOT NULL;
