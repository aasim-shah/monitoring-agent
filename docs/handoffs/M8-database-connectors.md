# Handoff — M8.2 Database connectors

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8-private-worker` |
| **Plan** | M8 plan Task 2 |
| **Workbooks** | WB-07 BR-07-02..04, TC-07-03..06 |

## Delivered

- **`packages/connector-sdk/src/templates.ts`: `defineTemplate`.** Only named, read-only templates can be defined (BR-07-02).
  - **SQL templates** must be one SELECT or WITH statement. Comments and literals are stripped before the checks. A template is rejected if it contains:
    - a DML, DDL, or session keyword: `INTO`, `SET`, `COPY`, `CALL`, …
    - a function that writes or sleeps: `pg_terminate_backend`, `set_config`, `nextval`, `lo_*`, `dblink`, `pg_sleep`, …
    - a row lock: `FOR UPDATE` or `FOR SHARE`
  - **MongoDB pipelines** may not use `$out`, `$merge`, `$function`, `$where`, or `$accumulator`.
- **Connector contract.** `templates` and `runTemplate`, `HealthResult.data`, and the reasons `authentication_failed`, `network_unreachable`, and `tls_unavailable`.
- **`@pcp/connectors-databases`** (`packages/connectors/databases`, private execution only):

| Connector | Validate (read-only check) | Health | Templates |
|---|---|---|---|
| `postgres` | superuser, CREATE on the database or a schema, or INSERT/UPDATE/DELETE/TRUNCATE on any table → `permission_denied` | connections vs `max_connections`, primary/standby, replication lag, database sizes, `pg_stat_statements` top 10 or "extension not installed" | `table_row_estimates`, `rows_created_per_day` |
| `mysql` | `SHOW GRANTS` with ALL/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/… outside system schemas | `Threads_connected` vs `max_connections`, replica lag, schema sizes, `Slow_queries` | `table_row_estimates`, `rows_created_per_day` |
| `mongodb` | `connectionStatus` privileges include insert/update/remove/create/drop/… | `serverStatus` connections, replica set members and lag, `dbStats` | `documents_per_day` |

**Rules that apply to every engine:**
- **Read-only sessions.**
  - PostgreSQL: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`.
  - MySQL: `SET SESSION TRANSACTION READ ONLY`.
  - MongoDB: `secondaryPreferred` reads with `maxTimeMS`.
- **Limits.** Statements time out after 5 s. Results stop at 1,000 rows plus a `truncated` flag; the cap is applied in the database (CTE or derived table, or `$limit`).
- **TLS.** On by default, with certificate verification. Plaintext needs `allowInsecure: true`.
- **Template identifiers.** `{{table}}`, `{{column}}`, `{{collection}}`, and `{{field}}` come from `config.templateParams` and are quoted by the driver. MongoDB field names must match `^[A-Za-z_][A-Za-z0-9_.]*$`.
- **Write override.** `writeOverrideAcknowledged: true` admits a write-capable user (UC-07-06); the control plane audits it in Task 5.
- **Error classification.** Failures are reported as network, TLS, authentication, or permission errors, or as a statement timeout.
- **Drivers.** `pg` 8.16.3, `mysql2` 3.24.5, and `mongodb` 7.7.0, all published at least two weeks earlier.

## Tests

- `pnpm --filter @pcp/connector-sdk test`: template guard, 16 cases.
- `pnpm --filter @pcp/connectors-databases test`: 17 passed, using Testcontainers `postgres:17.6-alpine`, `mysql:8.0` (TLS on), and `mongo:8.0` (FireMaps-like fixture). Covered:
  - a read-only user validates; a write-capable user gets `permission_denied`, and the override is accepted
  - health fields are filled
  - a template over a time window
  - 5,000 matching rows return 1,000 rows with `truncated: true`
  - an INSERT smuggled into a template is refused by the read-only session
  - authentication, network, and TLS failures are told apart
- A mutation check confirmed that the MySQL write check is pinned by its test.
