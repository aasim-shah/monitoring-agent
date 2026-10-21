# WB-09 · Websites, KPIs and Data Freshness

| | |
|---|---|
| **Milestones** | M13.5–M13.7 |
| **Spec** | §6.2, §7.4, §11.2, §11.3 |
| **Plan decisions** | D23; §3 website probes |
| **Owners** | Backend, Frontend |

## 1. Purpose and scope

Synthetic website monitoring, the KPI catalog with canonical definitions, and the freshness/completeness model that every chart, AI answer, and report uses to show stale or missing data honestly.

## 2. Actors

Admin (registers sites, defines KPIs), worker (probes), all members (view).

## 3. Use cases

| ID | Use case | Outcome |
|---|---|---|
| UC-09-01 | Verify domain control | DNS TXT or connected Cloudflare zone proves control |
| UC-09-02 | Register a website monitor | URL, interval, expected status, redirects, TLS checks saved |
| UC-09-03 | Run uptime, TLS, redirect, latency probes | Results stored as metrics; alerts on failure |
| UC-09-04 | Check a private URL through the agent | `http-check` pack on a customer host probes internal URLs |
| UC-09-05 | Define a KPI | Canonical definition with unit, timezone, window, source, caveats |
| UC-09-06 | View a KPI with freshness and completeness | Value plus "as of", source delay, coverage |
| UC-09-07 | Show stale or missing data | Explicit banners and gaps; never zeros |
| UC-09-08 | Compare periods | Deterministic comparison only between comparable definitions |

## 4. Flows

### UC-09-01 + UC-09-02: Domain verification and monitor

1. Admin enters `https://firemaps.com`.
2. If the zone is connected through Cloudflare → verified automatically.
3. Else the dashboard shows a TXT record `pcp-verify=<token>`; a job checks DNS every minute for 24 h.
4. Verified → Admin sets interval (default 60 s, min 30 s), expected status, allowed redirect chain, TLS check on.

### UC-09-03: Probe

1. Worker job per monitor runs on schedule.
2. Records: status code, final URL after redirects, redirect count, total time, TTFB, TLS certificate expiry and issuer.
3. Failures for 2 consecutive probes → availability alert (WB-13). TLS expiry < 14 days → warning.

### UC-09-05: KPI definition

| Field | Example |
|---|---|
| Key | `signups.daily` |
| Definition | "Accounts created, from `signups_per_day` template" |
| Unit | count |
| Timezone | Organization timezone |
| Window | 1 day |
| Source | MongoDB connection `prod-db` |
| Caveats | "Excludes test accounts flagged `is_test`" |

### UC-09-06 + UC-09-07: Freshness model

Per source and KPI: `last_successful_sync`, `last_attempt`, `source_delay`, `expected_update_interval`, `coverage_percent`, error code.

| State | Condition | UI |
|---|---|---|
| current | Last success within expected interval | Normal |
| stale | Last success older than 2× expected interval | Amber banner "Data as of <time>" |
| unavailable | No data or source failing | Grey panel "Unavailable: <reason>" |
| partial | Window incomplete (e.g. today in GA4) | Hatched / "partial" label |

## 5. Business rules

| ID | Rule |
|---|---|
| BR-09-01 | External sites are probed only after domain verification. |
| BR-09-02 | Probe interval default 60 s, minimum 30 s. |
| BR-09-03 | Every KPI has definition, unit, timezone, window, source, caveats. |
| BR-09-04 | Incomparable definitions (GA4 users vs authenticated users, browser vs server latency) cannot be combined. |
| BR-09-05 | Missing metrics are never replaced by zero. |
| BR-09-06 | Internal architecture is never inferred from a public website URL alone. |

## 6. Data

`metric_definitions`, `metric_aggregates`, `health_snapshots`, website monitor config in `assets` (`resource_type = website`) and probe metrics in VictoriaMetrics.

## 7. Screens

Websites & APIs (monitors, uptime, latency, TLS), Domain verification, KPI catalog, Analytics dashboards with freshness indicators.

## 8. Edge cases

| Case | Expected behavior |
|---|---|
| Site behind Cloudflare challenge page | Probe records status and flags "challenge detected"; suggest allowlisting probe user agent |
| Redirect loop | Stops at 10 redirects; reports loop |
| Probe worker overloaded | Probes report as delayed; never marks site down because of probe lag |
| Domain verification TXT removed later | Monitoring continues; re-verification every 30 days; failure pauses probes with notice |

## 9. Test cases

| ID | Covers | Given / When / Then |
|---|---|---|
| TC-09-01 | BR-09-01 | Unverified domain is not probed |
| TC-09-02 | UC-09-03 | TLS expiring in 13 days → warning |
| TC-09-03 | UC-09-03 | 2 consecutive failures → availability alert |
| TC-09-04 | BR-09-05 | Provider failure → KPI `null` with reason, never 0 |
| TC-09-05 | BR-09-04 | Summing GA4 users with authenticated users fails type and runtime checks |
| TC-09-06 | UC-09-07 | Last success at 3× interval → `stale` banner |

## 10. Task checklist

- [ ] M13.5 Website monitoring
- [ ] M13.6 KPI definitions and freshness
- [ ] M13.7 Analytics, ads, website, mobile screens

## 11. Acceptance criteria

1. Website probes raise availability and TLS alerts.
2. Every dashboard chart shows freshness and never renders missing data as zero.

## 12. Open items

- Multi-region probe locations are post-pilot (single central region for pilot).
