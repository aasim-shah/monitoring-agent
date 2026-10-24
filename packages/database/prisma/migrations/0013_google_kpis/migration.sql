-- Migration 0013: Google OAuth grants and daily KPI values (M13b, spec §7.2, §11.2, WB-08, WB-09).
-- Part 1 matches prisma migrate diff; part 2 adds RLS.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "account_email" TEXT,
ADD COLUMN     "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "metric_aggregates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "completeness" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_aggregates_organization_id_connection_id_day_idx" ON "metric_aggregates"("organization_id", "connection_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "metric_aggregates_connection_id_resource_type_external_id_m_key" ON "metric_aggregates"("connection_id", "resource_type", "external_id", "metric", "dimension", "day");

-- AddForeignKey
ALTER TABLE "metric_aggregates" ADD CONSTRAINT "metric_aggregates_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Part 2: row-level security =====
ALTER TABLE metric_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metric_aggregates
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());
