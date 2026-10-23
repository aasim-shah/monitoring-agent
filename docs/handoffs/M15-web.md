# Handoff — M15 Reports & Schedules page

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m15-reports` |
| **Plan** | M15 plan Task 5 |
| **Workbooks** | WB-15 §8 |

## Delivered

- **The Reports & Schedules page:**
  - **Schedules:** when ("08:00 Europe/Berlin"), where to, and the next run in local time and UTC. Run now, Pause/Resume, and Delete are shown for `report.manage`.
  - **Schedule dialog:**
    - fields: name, timezone (the organization's by default), local time, a channel checklist, and recipients
    - a live preview: "Next run: Mon 26 Oct, 08:00 (07:00 UTC) · covers 25 h"
    - checked before the API is called
  - **Report history:** day and version, narrative state, Late, and schedule.
- **The report view:**
  - The executive summary, with `[S#]` citations linking to their section, or "Narrative deferred" with the reasons.
  - The 12 sections, worded as in the email. Missing ones read "No data: …".
  - The delivery log (Sent, Retrying, Failed, with the last error), and Regenerate.
- **Nav:** "Reports & Schedules" is enabled for `report.view`.

## Tests

- **Web reports tests** (8): dialog validation and preview, list actions and viewer view, history rows, report view (missing sections, citations, delivery log, deferred narrative, regenerate).
- **Also:** the nav test. The web suite passes 154/154, and the production build succeeds.
