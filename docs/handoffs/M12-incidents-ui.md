# Handoff — M12.4 Incidents, alert rules, and channels UI

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m12-alerts` |
| **Plan** | M12 plan Task 7 |
| **Workbooks** | WB-13 §8 |

## Delivered

- **Navigation:**
  - "Incidents & Alerts" is enabled for `incident.view` and links to `/orgs/:org/products/:product/incidents`.
  - The organization menu gains "Notifications" (`org.settings.manage`).
- **Incidents page:**
  - The list shows severity, title (linked), status, start, and duration.
  - Filters are Active (the default), Resolved, and All. The empty state explains that incidents come only from real data.
  - The list refreshes every 30 s, and the page links to the alert rules.
- **Incident detail:**
  - Content:
    - the summary and resolution note
    - the timeline in plain words ("Notification suppressed (30-minute cooldown)", "Escalated: unacknowledged for 15 min")
    - the blast radius table (Confirmed, Potential, or Unknown, with the note that a dependency is not proof of an outage)
    - "No recent changes recorded." (change sources arrive with M7)
    - source links
  - Actions, for `incident.manage` only:
    - Acknowledge (open incidents only)
    - Resolve with a note
    - a Postmortem form: what happened, cause category, follow-ups one per line
- **Alert rules page:**
  - Each rule reads as words, for example "Above 90 % · For at least 10 min".
  - Rows show the severity and an enable switch, and can be deleted.
  - Buttons: "Add recommended rules" (shown when there are none) and "Add rule". The add dialog fills the template's defaults, checks its ranges, and preselects the template's severity.
- **Notification channels page** (organization):
  - Lists channels with type, where each sends (recipients or target host), status (Active or Broken), Send test, and Delete.
  - Adding a channel:
    - email takes 1–10 comma-separated addresses
    - Slack and webhook take an https URL only, plus an "Escalation channel" option
    - a webhook's signing secret is shown once, with a Copy button and a short description of the signature algorithm

## Tests

- `components/alerting/incidents.test.tsx` (6): the list and filters, and the detail (timeline order, blast radius, links, acknowledge and resolve, hidden actions, postmortem).
- `components/alerting/rules-channels.test.tsx` (8): the rule list (words, toggle, delete, recommended rules, permissions), the rule dialog (defaults, ranges, template switch), and the channels (list, email, webhook secret shown once, https only).
- `lib/nav.test.ts` covers the new entries.
- The full web suite passes (133).
