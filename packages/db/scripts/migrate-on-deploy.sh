#!/bin/sh
# Runs on Netlify before the app is built (netlify.toml, [build] command). A
# production build applies any pending Prisma migrations first, so new code is
# never published ahead of the schema it reads: Netlify only publishes a build
# that finished, and the migration is the first thing that build does.
#
#  - Not production (deploy previews, branch deploys): skip. A preview has its own
#    Neon branch, which .github/workflows/neon-preview-branches.yml migrates.
#  - Production without DATABASE_URL_UNPOOLED: FAIL the build. Skipping quietly is
#    exactly how a merge outruns the schema, and a failed build leaves the
#    previous deploy serving.
#  - Otherwise: `prisma migrate deploy`. The datasource's directUrl is
#    DATABASE_URL_UNPOOLED, which Prisma uses for migrations; the pooler is the
#    classic deploy-day failure (docs/15-OPS-RUNBOOK.md, Deployment).
#
# If a migration itself fails the build fails with it, Prisma records the
# migration as failed, and every later `migrate deploy` refuses to run until it
# is resolved by hand (runbook, "A migration failed on deploy").
#
# After the migrations, the role sync (src/sync-roles.ts) adds any role,
# permission or grant the permission matrix has and the database lacks. Roles are
# rows that nothing else ever updates after the first seed, so a new role in code
# (Admin, 2026-10-25) was never created in production. It is add-only and
# idempotent; a failure fails the build, so the previous deploy keeps serving.
# The first connect can hit a Neon database that is still waking, so it is tried
# up to three times (ROLE_SYNC_RETRY_SLEEP seconds apart).
set -eu

if [ "${CONTEXT:-}" != "production" ]; then
  echo "migrate-on-deploy: build context is '${CONTEXT:-unset}', not production; skipping."
  exit 0
fi

if [ -z "${DATABASE_URL_UNPOOLED:-}" ]; then
  echo "migrate-on-deploy: DATABASE_URL_UNPOOLED is not set for this production build." >&2
  echo "  Add it under Site configuration > Environment variables, with the Builds scope." >&2
  echo "  Refusing to publish code that may be ahead of the database schema." >&2
  exit 1
fi

# schema.prisma also names DATABASE_URL; migrations themselves use the direct URL.
export DATABASE_URL="${DATABASE_URL:-$DATABASE_URL_UNPOOLED}"

echo "migrate-on-deploy: applying pending migrations to the production database..."
pnpm --filter @desire/db exec prisma migrate deploy

echo "migrate-on-deploy: adding any missing roles, permissions and grants (add-only)..."
attempt=1
until DATABASE_URL="$DATABASE_URL_UNPOOLED" pnpm --filter @desire/db exec tsx scripts/sync-roles.ts --apply --allow-remote; do
  if [ "$attempt" -ge 3 ]; then
    echo "migrate-on-deploy: the role sync failed after $attempt attempts; failing the build." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  echo "migrate-on-deploy: the role sync failed; trying again ($attempt of 3)..." >&2
  sleep "${ROLE_SYNC_RETRY_SLEEP:-5}"
done
