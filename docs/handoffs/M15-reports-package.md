# Handoff — M15 Reports package

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m15-reports` |
| **Plan** | M15 plan Task 2 |
| **Workbooks** | WB-15 UC-15-02/05/06/07, BR-15-01/02/03/05, TC-15-01/02/04/05/06 |

## Delivered

`packages/reports`:

- **`window.ts` (Luxon):**
  - `reportWindow(tz, runAt)` returns the prior complete local day (23, 24, or 25 h).
  - `nextRunAt(tz, HH:MM, after)`: a wall time inside a DST gap shifts forward by the gap.
  - Also `localDayWindow`, `previousWindow`, `isValidTimezone`, and `isValidLocalTime`.
- **`templates/daily.ts`:** the 12 sections of inital.md §13, cited as `[S1]`…`[S12]`.
- **`snapshot.ts`:** `buildSnapshot(sources, window)`.
  - Every number is rounded once.
  - Missing sources are `null` with a reason, and are never zero:
    - Google Analytics (M13b)
    - ads
    - deployments (M7)
    - any source without data
  - URLs lose their query strings.
  - Anomalies: a change of at least 50 % against the previous day, above a floor.
  - Suggested actions come from fixed rules.
- **`narrative.ts`:** `narrate(snapshot, provider, { disabled })`.
  - The provider gets the sanitized section summary only, with no tools.
  - `validateAnswer` checks the result with `[S#]` citations. A failure is retried once, then the narrative is deferred.
  - A provider failure gives `deferred`; AI turned off gives `disabled`.
- **`render.ts`:**
  - `renderReport` builds the email (text and HTML), Slack, and webhook bodies.
  - `sectionLines` is shared with the web view through `@pcp/reports/render`, which has no runtime imports.
- **`validateAnswer`** (`@pcp/ai-orchestrator`) takes an optional citation pattern.

## Tests

- **Reports** (23):
  - TC-15-01/02: Berlin 25 h and 23 h days; Karachi; the DST gap
  - TC-15-05/04: an unsupported number, then a provider failure
  - TC-15-06: missing sources
  - anomalies, actions, sanitizing, and rendering
- **AI orchestrator:** 19.
