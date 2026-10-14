#!/usr/bin/env bash
# Applies pending Prisma migrations as part of a PRODUCTION Netlify build.
#
# Called from netlify.toml between `prisma generate` and `next build`, from
# the repo root. See docs/15-OPS-RUNBOOK.md, "Deployment".
#
# Why it exists: nothing else applied migrations to production. CI migrates its
# own throwaway Postgres and neon-preview-branches.yml migrates per-PR Neon
# branches, so code that needed new columns shipped to a database that did not
# have them (2026-10-13; PROGRESS.md).
#
# Three rules, each there because the alternative is a real failure mode:
#
# 1. PRODUCTION ONLY. Netlify's base DATABASE_URL for the deploy-preview and
#    branch-deploy contexts is the PRODUCTION database; only the per-PR
#    override set by neon-preview-branches.yml redirects them, and that
#    override is absent whenever the workflow has not run or has failed. An
#    unguarded step would apply a PR's unmerged migration to production.
#
# 2. SAME DATABASE AS THE APP. The target is derived from DATABASE_URL -- what
#    the deployed functions actually connect to -- rather than read from
#    DATABASE_URL_UNPOOLED. The two are set independently and the app never
#    reads the second, so they can drift (after a database move, say), and a
#    "successful" migration would land on a database nobody serves from.
#
# 3. FAIL CLOSED. Any failure exits non-zero, the build fails, and Netlify
#    keeps serving the previous deploy.
#
# The migration runs while the PREVIOUS code is still live, so it has to be
# safe for that code: additive changes only (docs/15-OPS-RUNBOOK.md,
# expand-contract). A rename or drop belongs in a later release than the code
# that stops using the old name.
set -euo pipefail

context="${CONTEXT:-unset}"
if [ "$context" != "production" ]; then
  echo "migrate-on-deploy: CONTEXT=$context is not production; not running migrations."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate-on-deploy: DATABASE_URL is not set in the build environment." >&2
  echo "  In Netlify it needs the \"Builds\" scope as well as Functions and Runtime." >&2
  exit 1
fi

# Neon's pooled host is the direct host with "-pooler" appended to the endpoint
# id (ep-xxx-pooler.region... vs ep-xxx.region...). Migrations need the direct
# one: Prisma takes a session-level advisory lock, and a transaction-mode pooler
# is free to hand each statement a different server connection.
# Only the host part is rewritten, so a password containing "-pooler" survives.
direct_url="$(printf '%s' "$DATABASE_URL" | sed -E 's#(@[^/:?]*)-pooler#\1#')"

# Neon scales to zero. A build after a quiet spell has to wake the compute, and
# Prisma's default 5 s connect timeout can lose that race.
case "$direct_url" in
  *connect_timeout=*) ;;
  *\?*) direct_url="${direct_url}&connect_timeout=30" ;;
  *)    direct_url="${direct_url}?connect_timeout=30" ;;
esac

# Log the host only -- the URL carries the password.
host="$(printf '%s' "$direct_url" | sed -nE 's#^[a-zA-Z0-9+.-]+://[^@]*@([^/:?]+).*#\1#p')"
echo "migrate-on-deploy: applying pending migrations to ${host:-<host not parsed>}"

DATABASE_URL="$direct_url" DATABASE_URL_UNPOOLED="$direct_url" \
  pnpm --filter @desire/db exec prisma migrate deploy
