-- Migration 0002: product of an environment, for product-scoped permission checks
-- on environment routes (TenantGuard). Same membership rule as 0001's resolvers.
CREATE FUNCTION pcp_resolve_environment_product(p_environment uuid, p_user uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT e.product_id
    FROM environments e
    JOIN organization_members m ON m.organization_id = e.organization_id AND m.user_id = p_user
    WHERE e.id = p_environment
  $$;

ALTER FUNCTION pcp_resolve_environment_product(uuid, uuid) OWNER TO pcp_rls_definer;
REVOKE ALL ON FUNCTION pcp_resolve_environment_product(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pcp_resolve_environment_product(uuid, uuid) TO pcp_app;
