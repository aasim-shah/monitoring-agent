# Handoff — Managed databases (Atlas, Supabase, RDS)

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m8b-managed-databases` (from `feat/m8-private-worker`) |
| **Why** | The user's databases are MongoDB Atlas and Supabase. The private worker (M8) only covers databases inside a private network. |

## Delivered

- **Connectors (`@pcp/connectors-databases`)**:
  - PostgreSQL, MySQL, and MongoDB can run in **cloud** execution.
  - **Credentials:** a pasted connection string, or username and password. All three credential fields are optional; `CredentialField.required` was added.
  - **Destination checks for cloud execution:** TLS is mandatory. Every host must resolve to public addresses only, including MongoDB SRV targets (BR-07-06), so a connection cannot reach the platform's own Postgres or Redis.
  - **Address pinning:** PostgreSQL and MySQL connect to the vetted address, with SNI and verification on the hostname. TLS follows config, never a pasted `sslmode`.
- **API:**
  - **Authorize with a connection string:** the engine must match the provider. Only `host`, `port`, and `database` go into config; the string itself is stored encrypted (ADR 0004).
  - **Plaintext refused:** creating a managed database without TLS returns 400.
  - **Catalog:** returns `egressIp` from `PLATFORM_EGRESS_IP`.
  - **Removal:** removing a connection disables its job schedules.
- **Runtime and jobs:**
  - `ConnectorRuntime.health` records health data as JSON. A failure degrades a connected connection; a later success recovers it, except after `permission_denied` or `reauthorization_required`.
  - When a cloud connection with a health check is validated as connected, the runtime upserts a `connection-health` job definition running every 300 s.
  - The new `connection-health` job kind is run by the worker.
- **Web, Add database:** a mode choice between **Managed (Atlas, Supabase, RDS…)**, the default when there is no worker, and **Private network (worker)**.
  - The connection string is entered in a password field. Engine, host, port, and database are read in the browser; the password is never placed in config.
  - **Verify server certificate:** on by default, and off by default for Supabase hosts, because Supabase uses its own CA. The connection is still encrypted, and the dialog explains this.
  - **Allowlisting:** an Atlas hint shows the platform IP to allow.
  - Read-only user commands are shown for each engine.
- **Production** must run the `worker` service, which executes validation and health jobs. Its memory is capped in `compose.vps.yaml`.

## Tests

| Suite | Result | Covers |
|---|---|---|
| connectors-databases | 22 | Connection-string parsing; connecting with a string; cloud refuses `127.0.0.1`, `10.x`, `localhost`, `169.254.169.254`; cloud requires TLS |
| connector-runtime | 18 | Health records, degrades, and recovers; health schedule created once |
| jobs | 6 | Health job writes `connection_health` |
| API connections + agents | 74 | Managed authorize (no password in config), engine mismatch, empty credentials, plaintext refused, egress IP, schedules disabled on removal |
| web | 100 | Supabase string (verification off), Atlas SRV (IP hint), invalid string, private mode unchanged |
