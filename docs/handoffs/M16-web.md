# Handoff — M16 Automations & Approvals page

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-24 |
| **Branch** | `feat/m16-actions` |
| **Plan** | M16 plan Task 5 |
| **Workbooks** | WB-16 §8 |

## Delivered

- **The Automations & Approvals page:**
  - **Requests:** what, on which host, state, impact, and an "AI" badge.
    - Approve and Reject for members with `action.propose`. Reject needs a note.
    - In production the requester sees "Waiting for another approver" instead of Approve.
  - **Propose restart dialog:** the host, then only the units the environment's policy allows, then a reason.
  - **Policies:** capability × environment, Disabled by default.
    - The edit dialog has enabled, a unit allowlist (validated), approver roles, and "Allow without approval", which is disabled in production.
    - Cloudflare and GitHub show "Needs a … connection".
- **The action detail page:** a timeline (proposed, approved, executed by pcp-helper, then verified or failed with the reason) and the impact.
- **Nav:** "Automations & Approvals" is enabled for `incident.view`.

## Tests

- **Web action tests** (8): the policy form, unit validation, unavailable providers, the approve and reject flows, the requester view, the detail timeline, and the propose dialog.
- **Also:** the nav test. The web suite passes 162/162.
