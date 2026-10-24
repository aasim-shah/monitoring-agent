-- Migration 0015: telemetry usage per tenant and minute, and live boosts (M10.6, M10.7).
-- Part 1 matches prisma migrate diff; part 2 adds RLS.

-- CreateTable
CREATE TABLE "telemetry_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "minute" TIMESTAMPTZ(6) NOT NULL,
    "active_series" INTEGER NOT NULL,
    "samples" BIGINT NOT NULL,
    "refused_series_requests" INTEGER NOT NULL DEFAULT 0,
    "refused_rate_requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "telemetry_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_live_boosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "pack_id" TEXT NOT NULL,
    "task_id" UUID,
    "created_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_live_boosts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_usage_organization_id_minute_key" ON "telemetry_usage"("organization_id", "minute");

-- CreateIndex
CREATE INDEX "agent_live_boosts_organization_id_expires_at_idx" ON "agent_live_boosts"("organization_id", "expires_at");

-- AddForeignKey
ALTER TABLE "telemetry_usage" ADD CONSTRAINT "telemetry_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_live_boosts" ADD CONSTRAINT "agent_live_boosts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Part 2: row-level security =====
ALTER TABLE telemetry_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telemetry_usage
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());

ALTER TABLE agent_live_boosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_live_boosts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_live_boosts
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());
