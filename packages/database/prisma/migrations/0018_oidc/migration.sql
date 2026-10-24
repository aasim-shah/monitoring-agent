-- Migration 0018: OIDC sign-in subject for self-hosted deployments (M19.4).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "oidc_subject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_subject_key" ON "users"("oidc_subject");

