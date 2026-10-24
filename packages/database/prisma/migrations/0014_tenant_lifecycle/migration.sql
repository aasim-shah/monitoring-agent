-- Migration 0014: tenant export and deletion (M19.8, WB-17 UC-17-09).
-- Part 1 matches prisma migrate diff; part 2 adds RLS; part 3 the membership and scheduler functions.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "deletion_requested_by_user_id" UUID,
ADD COLUMN     "deletion_scheduled_for" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "tenant_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "status" TEXT NOT NULL,
    "archive" BYTEA,
    "size_bytes" INTEGER,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "deletion_requested_at" TIMESTAMPTZ(6) NOT NULL,
    "purged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "deleted_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_exports_organization_id_created_at_idx" ON "tenant_exports"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tenant_exports" ADD CONSTRAINT "tenant_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Part 2: row-level security =====
ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_exports
  USING (organization_id = pcp_current_org()) WITH CHECK (organization_id = pcp_current_org());

-- deleted_organizations is a platform record, not tenant data: the app may only add rows.
REVOKE ALL ON deleted_organizations FROM pcp_app;
GRANT INSERT ON deleted_organizations TO pcp_app;

-- ===== Part 3: access during the grace period and the purge schedule =====
-- Members of an organization pending deletion lose access; owners keep it to export or cancel.
CREATE OR REPLACE FUNCTION pcp_user_memberships(p_user uuid)
  RETURNS TABLE (
    organization_id uuid,
    organization_name text,
    role member_role,
    all_products boolean,
    product_ids uuid[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.organization_id, o.name, m.role, m.all_products, m.product_ids
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = p_user
      AND (o.deletion_requested_at IS NULL OR m.role = 'owner')
    ORDER BY o.name
  $$;

-- Reports stop during the grace period (and resume if the deletion is cancelled).
CREATE OR REPLACE FUNCTION pcp_due_report_schedules(p_now timestamptz)
  RETURNS TABLE (organization_id uuid, id uuid, next_run_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.organization_id, s.id, s.next_run_at FROM report_schedules s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.enabled AND s.next_run_at <= p_now AND o.deletion_requested_at IS NULL
    ORDER BY s.next_run_at
    LIMIT 500
  $$;

CREATE FUNCTION pcp_due_tenant_purges(p_now timestamptz)
  RETURNS TABLE (id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.id FROM organizations o
    WHERE o.deletion_scheduled_for IS NOT NULL AND o.deletion_scheduled_for <= p_now
    ORDER BY o.deletion_scheduled_for
    LIMIT 20
  $$;
ALTER FUNCTION pcp_due_tenant_purges(timestamptz) OWNER TO pcp_rls_definer;
REVOKE ALL ON FUNCTION pcp_due_tenant_purges(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pcp_due_tenant_purges(timestamptz) TO pcp_scheduler;

-- Expired export links lose their archive (the definer may only clear these columns).
GRANT UPDATE (archive, status) ON tenant_exports TO pcp_rls_definer;
CREATE FUNCTION pcp_expire_tenant_exports(p_now timestamptz)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH expired AS (
      UPDATE tenant_exports SET archive = NULL, status = 'expired'
      WHERE status = 'ready' AND expires_at <= p_now
      RETURNING 1
    )
    SELECT count(*)::int FROM expired
  $$;
ALTER FUNCTION pcp_expire_tenant_exports(timestamptz) OWNER TO pcp_rls_definer;
REVOKE ALL ON FUNCTION pcp_expire_tenant_exports(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pcp_expire_tenant_exports(timestamptz) TO pcp_scheduler;

-- The app may never delete audit entries (tamper resistance). Only the purge may, and only for an
-- organization whose grace period has ended; deleted_organizations keeps the summary.
GRANT DELETE ON audit_logs TO pcp_rls_definer;
CREATE FUNCTION pcp_purge_audit_logs(p_org uuid, p_now timestamptz)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH gone AS (
      DELETE FROM audit_logs a
      USING organizations o
      WHERE a.organization_id = p_org AND o.id = p_org
        AND o.deletion_scheduled_for IS NOT NULL AND o.deletion_scheduled_for <= p_now
      RETURNING 1
    )
    SELECT count(*)::int FROM gone
  $$;
ALTER FUNCTION pcp_purge_audit_logs(uuid, timestamptz) OWNER TO pcp_rls_definer;
REVOKE ALL ON FUNCTION pcp_purge_audit_logs(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pcp_purge_audit_logs(uuid, timestamptz) TO pcp_scheduler;
