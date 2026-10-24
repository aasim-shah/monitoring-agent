# M15b Daily Report — 24h Activity and Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The owner asked for a daily email that covers every connected resource for the past 24 hours, with trends. It should include new records in each database, website availability and speed, Search Console, GA4, Play vitals, and Firebase apps, each compared with the day before.

**Architecture:**
- **Database connectors:** health checks also record per-table or per-collection row counts (and cumulative inserts for PostgreSQL).
- **Report sources:** derive the 24-hour change from the health snapshots at the start and end of the window.
- **Analytics:** each KPI uses the latest day the provider has published and compares it with the day before. Search Console and Play publish about 2 days late, so the report states which day it shows.
- **Websites:** add average and p95 response time and failed checks, beside uptime, with yesterday's figures.
- **Email:** each line carries its trend ("▲ 12 % vs Oct 23"). The AI narrative cites the new sections like the others.

**Spec:** spec §13.3 (daily report), §11.3 (freshness); WB-15; owner request 2026-10-25.

## Global Constraints

- **Read-only:** row counts come from catalog statistics (`pg_stat_user_tables`, `information_schema.TABLES`, `estimatedDocumentCount`). There are no free-form queries and no row contents (BR-07-02).
- **Limits:** at most 50 tables or collections per database, largest first.
- **Missing data:** when a provider has no data for a day, the report says "no data". It never shows 0 and never shows a trend computed from nothing.
- **Approximate counts:** MySQL `table_rows` and MongoDB estimates are approximate, and the report says so.

## Review Focus

1. A PostgreSQL stats reset during the window (inserts counter went down) shows "counter reset", not a negative number.
2. A table that appeared during the window shows as new, without a fake delta.
3. A health snapshot missing at the window start uses the closest earlier one within 6 hours; otherwise "no baseline".
4. GA4 today is partial: the report uses the report's local day and labels it partial when it is.
5. Search Console's latest published day is shown with its date, never as "today".

### Task 1: Per-table and per-collection counts in database health

- **PostgreSQL:** the top 50 tables by live rows, as `tables: [{ name: 'schema.table', rows: n_live_tup, inserted: n_tup_ins }]`.
- **MySQL:** the top 50 tables by `table_rows`, as `tables: [{ name, rows }]`, marked approximate.
- **MongoDB:** collections with `estimatedDocumentCount`, the top 50 by count, as `collections: [{ name, documents }]`.
- **Tests:** the existing database integration tests against real containers gain assertions on the new fields.

### Task 2: Report sources and snapshot

- **`databases(w)`:** returns per database:
  - status, size, and change in size
  - the total row or document change
  - the top 10 tables or collections by growth: `[{ name, added, total }]`
  - `baseline: 'ok' | 'none' | 'reset'`
- **`websites(w)`:** adds `avgMs`, `p95Ms`, `failedChecks`, and the previous day's `uptimePercent` and `avgMs`.
- **`analytics(w)`:** per KPI `{ label, value, day, previous, previousDay, partial }`, using the latest day at or before the report date that has a value. Includes the scoped Firebase apps by name.
- **Tests:** reports package unit tests and worker integration tests with seeded health rows and metric aggregates.

### Task 3: Rendering and narrative

- **Lines:**
  - `orders: +120 (now 4,310)`
  - `Active users 120 (▲ 12 % vs Oct 23)`
  - `Search clicks 42 on Oct 22 (▼ 5 % vs Oct 21)`
  - `getrestro.com: 100 % up, avg 180 ms (p95 420 ms), ▲ 20 ms vs yesterday`
- **Trend arrows:** shown only when both values exist.
- **Tests:** render tests for every line shape, including "no baseline" and "counter reset".

### Task 4: Deploy and send

- Full pipeline, then deploy the worker, api, and web.
- Regenerate the owner's latest report through the existing "Regenerate" path. That sends the email.
