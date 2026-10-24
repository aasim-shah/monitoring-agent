-- Migration 0017: data inspection (M18.2); later parts: retained logs (M18.1).
-- Part 1 matches prisma migrate diff; part 2 adds RLS and tenant resolution.

-- AlterTable
ALTER TABLE "agent_pack_assignments" ADD COLUMN     "inspection" JSONB NOT NULL DEFAULT '{"enabled": false}';

-- CreateTable
CREATE TABLE "inspection_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "pack_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "topic" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "task_id" UUID,
    "requested_by_user_id" UUID,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "inspection_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inspection_requests_organization_id_agent_id_created_at_idx" ON "inspection_requests"("organization_id", "agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inspection_requests_task_id_idx" ON "inspection_requests"("task_id");

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Part 2: row-level security and /inspections/:id resolution =====
ALTER TABLE inspection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inspection_requests
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());

CREATE FUNCTION pcp_resolve_inspection_request(p_id uuid, p_user uuid)
  RETURNS TABLE (organization_id uuid, product_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT r.organization_id, a.product_id FROM inspection_requests r
    JOIN agents a ON a.id = r.agent_id AND a.organization_id = r.organization_id
    JOIN organization_members m ON m.organization_id = r.organization_id AND m.user_id = p_user
    WHERE r.id = p_id
  $$;
ALTER FUNCTION pcp_resolve_inspection_request(uuid, uuid) OWNER TO pcp_rls_definer;
REVOKE ALL ON FUNCTION pcp_resolve_inspection_request(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pcp_resolve_inspection_request(uuid, uuid) TO pcp_app;
