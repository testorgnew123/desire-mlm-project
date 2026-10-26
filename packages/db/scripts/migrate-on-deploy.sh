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
