# Handoff — M15 Reports schema (migration 0010)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m15-reports` |
| **Plan** | M15 plan Task 1 |
| **Workbooks** | WB-15 §6, BR-15-04/06/07 |

## Delivered

- **Tables**, each with forced RLS on `organization_id`:

  | Table | Holds |
  |---|---|
  | `report_schedules` | timezone, `local_time` (`HH:MM`), channel IDs, recipients, `next_run_at` |
  | `generated_reports` | one row per schedule, local date, and version (unique); snapshot JSON, narrative, `narrative_status`, problems, `late` |
  | `report_deliveries` | one row per report and target (unique) |

  - A delivery's target is a channel (`channel:<id>`) or an email address.
  - Delivery status reuses `delivery_status` (pending, sent, failed, dead).
- **Scheduler functions**, `pcp_scheduler` only:
  - `pcp_due_report_schedules(now)`
  - `pcp_advance_report_schedule(id, expected, next)`, a compare-and-set. The definer role may update `next_run_at` only.
- **Tenant guard:** `pcp_resolve_report_object(kind, id, user)` for schedules and reports, members only.
- **Jobs:**
  - New kinds `report-generate` (entity = schedule) and `report-deliver` (entity = delivery).
  - The payload gains an optional `window`: the local date, plus `__v<n>` for a version.
  - Every handler-backed kind now routes to its handler.

## Tests

- **Database** (`reports.int.test.ts`, 5): RLS, scheduler-only access, compare-and-set, one version 1 per date, and the resolver.
- **Also:** the RLS seed, schema drift, and the job ID format.
