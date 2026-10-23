# Handoff — M15 Reports API

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m15-reports` |
| **Plan** | M15 plan Task 4 |
| **Workbooks** | WB-15 §7, UC-15-01/04/09 |

## Delivered

| Route | Behavior |
|---|---|
| `POST /api/v1/report-schedules` | The product is in the body. The tenant guard gains `TenantScope({ body: 'productId' })`. Validates the IANA timezone, `HH:MM`, the organization's channels, and at most 10 valid emails, with at least one destination. |
| `PATCH /api/v1/report-schedules/:id` | A changed timezone or time recomputes `nextRunAt`. |
| `DELETE /api/v1/report-schedules/:id` | |
| `POST /api/v1/report-schedules/:id/run` | Runs the prior local day as the next version. |
| `GET /api/v1/products/:id/report-schedules` | |
| `GET /api/v1/products/:id/report-schedules/preview` | Returns `{nextRunAt, localDate, windowHours}`. |
| `GET /api/v1/products/:id/reports` | |
| `GET /api/v1/reports/:id` | The snapshot, narrative, problems, and the delivery log, with channel names. |
| `POST /api/v1/reports/:id/regenerate` | Queues the next version. Returns 409 when the schedule was deleted. |

- **Permissions:** `report.view` to read; `report.manage` (operator and up) for everything else.
- **Audit:** create, update, delete, run, and regenerate are audited.
- **OpenAPI:** the schemas `ReportSchedule`, `ReportSummary`, `ReportSection`, and `Report`, with the client regenerated.

## Tests

- **API reports tests** (7):
  - CRUD and audit
  - validation
  - preview with Berlin's 25 h day
  - run queues the job
  - viewer and cross-tenant 404s
  - history, detail, and regenerate
  - 409 without a schedule
- **Also:** the full API suite passes, 243/243.
