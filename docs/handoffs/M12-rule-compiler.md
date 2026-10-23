# Handoff — M12.1 Rule templates and vmalert compiler

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 2 |
| **Workbooks** | WB-13 UC-13-01, BR-13-06 |

## Delivered

- **`packages/alerting`** (new).
- **Templates** (`templates.ts`): users choose a template and set its parameters, and never write PromQL.

  | Template | Kind | Default |
  |---|---|---|
  | `host_cpu_high` | metric | > 90 % for 10 min, warning |
  | `host_memory_high` | metric | > 90 % for 10 min, warning |
  | `host_disk_full` | metric | > 90 % for 5 min, critical |
  | `log_error_spike` | metric | > 10 errors/min for 5 min, warning; uses `increase_pure` over `log_lines_total` |
  | `agent_heartbeat_missing` | worker | 5 min, critical |
  | `connection_degraded` | worker | 15 min, warning |

  - `validateParams` fills defaults, clamps values to the template's ranges, and rejects unknown keys, so a `promql` key is refused.
  - `RECOMMENDED` lists all templates except `connection_degraded`.
- **Compiler** (`compiler.ts`): `compileTenant(orgId, rules, {interval})` returns the tenant's vmalert file.
  - Organization-wide rules go in group `tenant-<org>`. Each product gets group `tenant-<org>-product-<id>`.
  - Every group queries with `params.extra_label: tenant_id=<org>`; product groups add `extra_filters: {product_id="<id>"}`.
  - Group labels carry `tenant_id` and, for product groups, `product_id`.
  - Each rule gets `alert: <template>-<id8>`, `for`, and labels `rule_id` and `severity`. Its annotations are `summary`, the rule name, and `value`.
  - Disabled and worker rules are omitted. With no rules left the file is `groups: []`.

## Tests

- `compiler.test.ts`: groups and scopes, disabled and worker rules, the test interval, parameter validation, and a check that every template is complete.
- `vmalert.int.test.ts` (TC-13-01): real VictoriaMetrics and vmalert. Tenants A and B both run hot with the same `agent_id`, and only A's alert fires, labelled with `tenant_id=A`.
