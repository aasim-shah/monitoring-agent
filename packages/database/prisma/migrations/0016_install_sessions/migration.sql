-- Migration 0016: assisted SSH install sessions (M17.3). No column can hold a credential (BR-05-05).
-- Part 1 matches prisma migrate diff; part 2 adds RLS.

-- CreateEnum
CREATE TYPE "InstallMode" AS ENUM ('key', 'password');

-- CreateTable
CREATE TABLE "install_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "mode" "InstallMode" NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "install_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "install_session_hosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "fingerprint" TEXT,
    "fingerprint_confirmed_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "output" TEXT NOT NULL DEFAULT '',
    "script_version" TEXT,
    "cleanup" TEXT,
    "error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "install_session_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "install_sessions_organization_id_created_at_idx" ON "install_sessions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "install_sessions_organization_id_id_key" ON "install_sessions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "install_session_hosts_session_id_idx" ON "install_session_hosts"("session_id");

-- AddForeignKey
ALTER TABLE "install_sessions" ADD CONSTRAINT "install_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "install_session_hosts" ADD CONSTRAINT "install_session_hosts_organization_id_session_id_fkey" FOREIGN KEY ("organization_id", "session_id") REFERENCES "install_sessions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Part 2: row-level security =====
ALTER TABLE install_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON install_sessions
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());

ALTER TABLE install_session_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_session_hosts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON install_session_hosts
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());
