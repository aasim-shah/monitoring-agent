# Writing a connector

Audience: an engineer adding a provider (an API the platform reads, and optionally acts on) to the Product Control Plane.
Contract: spec §9 and `packages/connector-sdk`. Examples: `packages/connectors/prometheus` (read-only, cloud), `packages/connectors/databases` (private worker), `packages/connectors/github` (webhooks and actions), `packages/connectors/mock` (every behaviour, tests only).

## 1. Shape

A connector is a plain object implementing `Connector` from `@pcp/connector-sdk`:

| Field | Meaning |
|---|---|
| `type`, `version`, `displayName` | `type` is the provider id stored on connections; bump `version` on behaviour changes |
| `executionLocations` | `cloud` (platform workers) and/or `private` (the customer's private worker, for databases inside their network) |
| `credentialFields` | what the user types; `secret: true` fields are encrypted with the tenant key and never returned |
| `capabilities()` | the methods it implements; the registry refuses a connector whose capabilities and methods disagree |
| `configSchema()`, `validateConfig()` | non-secret settings (URLs, account ids) |
| `validate`, `discover`, `sync`, `health`, `collect`, `ingestEvent`, `registerWebhook`, `refreshCredential`, `executeAction` | one per capability |

Every method receives an `ExecutionContext`: `connectionId`, the tenant scope, `config`, `credentials()` (decrypted on demand), `grantedScopes`, and a deadline. Never take a tenant or connection id from provider data or the request body.

## 2. Rules (enforced in review and tests)

- **HTTP only through `createHttpClient`**: it applies the SSRF guard (no private, loopback, link-local, or metadata addresses unless the connection explicitly runs in a private worker), size limits, timeouts, and redirect limits.
- **Errors are `ConnectorError(reason, message)`** with a reason from `ConnectorErrorReason` (`reauthorization_required`, `rate_limited` with `retryAfterSeconds`, `permission_denied`, `provider_unavailable`, `invalid_config`, …). The runtime maps reasons to connection status and retries; a plain `Error` becomes "Something went wrong" and its message is redacted.
- **No secrets in messages**: the runtime redacts known credential values, but do not put tokens, URLs with passwords, or response bodies into errors.
- **Read only unless the capability says otherwise**: `executeAction` runs only for approved actions (WB-16) and must verify its effect.
- **Bounded work**: page through large lists, cap items (see `MAX_TARGETS` in the Prometheus connector), and respect the deadline.
- **Observations, not copies**: discovery emits `Observation`s (resource type, external id, attributes, confidence, evidence) for the asset graph; metrics stay in the provider unless `sync` stores daily KPIs.

## 3. Register it

1. Create `packages/connectors/<name>` (copy the Prometheus package layout: `src/index.ts`, `src/<name>.test.ts`, `package.json`, `tsconfig*.json`).
2. Add it to `production` in `packages/connector-runtime/src/registry.ts`.
3. Add the provider to the web catalog (`apps/web/components/integrations`) and, if it needs OAuth, follow the Google connector (state bound to user and connection, PKCE, 10-minute single-use state).
4. Document the permissions the customer grants in `docs/integrations/<name>.md`.

## 4. Tests a connector needs

| Test | How |
|---|---|
| Config validation | valid and invalid configs, URLs with credentials refused |
| Each capability against a fake provider | `createXConnector({ fetch })` with a scripted `fetch`, or a local HTTP server |
| Error mapping | 401 → `reauthorization_required`, 403 → `permission_denied`, 429 → `rate_limited` with retry-after, 5xx/HTML → `provider_unavailable` |
| SSRF | a private or metadata address is refused (`destination_blocked`) |
| Redaction | an error never contains a credential (see the mock connector's `leaky` behaviour) |
| Runtime integration | `packages/connector-runtime` int tests with the mock connector show the state machine; add a case if your connector has new states |

Run `pnpm --filter @pcp/connectors-<name> test` and the full `pnpm test` before a pull request.
