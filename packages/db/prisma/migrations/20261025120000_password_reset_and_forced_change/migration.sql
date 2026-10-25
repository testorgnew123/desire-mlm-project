-- A temporary password somebody else chose must be replaced by the person it was
-- issued to: users.mustChangePassword is set for a new account and an admin
-- reset, and login sends the person to choose their own first.
--
-- password_reset_tokens backs "forgot password": a single-use, expiring link.
-- Only the SHA-256 of the token is stored (same idea as sessions.tokenHash).
--
-- Both changes are additive. Existing users keep mustChangePassword = false.
-- (Prisma's generator also wants to DROP INDEX "associate_hierarchy_path_prefix",
-- the hand-written text_pattern_ops index; it is deliberately not here.)

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_createdAt_idx" ON "password_reset_tokens"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
