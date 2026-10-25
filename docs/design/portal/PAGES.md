# Portal page coverage

34 existing portal routes are covered in the connected preview. The landing page remains in its separate approved draft. Use the sidebar or All pages selector; detail screens are also linked from parent tables. Every screen is a design prototype with illustrative data, not a live application integration.

| Application route | Preview key | Existing source |
| --- | --- | --- |
| `/orgs/[orgId]/audit` | `audit` | `apps/web/app/(app)/orgs/[orgId]/audit/page.tsx` |
| `/orgs/[orgId]/members` | `members` | `apps/web/app/(app)/orgs/[orgId]/members/page.tsx` |
| `/orgs/[orgId]` | `overview` | `apps/web/app/(app)/orgs/[orgId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/agents/[agentId]` | `agent` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/agents/[agentId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/agents` | `agents` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/agents/page.tsx` |
| `/orgs/[orgId]/products/[productId]/ai` | `ai` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/ai/page.tsx` |
| `/orgs/[orgId]/products/[productId]/alert-rules` | `alert-rules` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/alert-rules/page.tsx` |
| `/orgs/[orgId]/products/[productId]/analytics` | `analytics` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/analytics/page.tsx` |
| `/orgs/[orgId]/products/[productId]/assets/[assetId]` | `asset` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/assets/[assetId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/assets` | `assets` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/assets/page.tsx` |
| `/orgs/[orgId]/products/[productId]/automations/[actionId]` | `action` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/automations/[actionId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/automations` | `automations` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/automations/page.tsx` |
| `/orgs/[orgId]/products/[productId]/databases` | `databases` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/databases/page.tsx` |
| `/orgs/[orgId]/products/[productId]/incidents/[incidentId]` | `incident` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/incidents/[incidentId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/incidents` | `incidents` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/incidents/page.tsx` |
| `/orgs/[orgId]/products/[productId]/infrastructure/[agentId]` | `host` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/infrastructure/[agentId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/infrastructure` | `infrastructure` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/infrastructure/page.tsx` |
| `/orgs/[orgId]/products/[productId]/integrations/[connectionId]` | `connection` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/integrations/[connectionId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/integrations` | `integrations` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/integrations/page.tsx` |
| `/orgs/[orgId]/products/[productId]/mobile` | `mobile` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/mobile/page.tsx` |
| `/orgs/[orgId]/products/[productId]` | `health` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/reports/[reportId]` | `report-detail` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/reports/[reportId]/page.tsx` |
| `/orgs/[orgId]/products/[productId]/reports` | `reports` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/reports/page.tsx` |
| `/orgs/[orgId]/products/[productId]/websites` | `websites` | `apps/web/app/(app)/orgs/[orgId]/products/[productId]/websites/page.tsx` |
| `/orgs/[orgId]/settings/notifications` | `notifications` | `apps/web/app/(app)/orgs/[orgId]/settings/notifications/page.tsx` |
| `/orgs/[orgId]/settings` | `settings` | `apps/web/app/(app)/orgs/[orgId]/settings/page.tsx` |
| `/orgs/[orgId]/usage` | `usage` | `apps/web/app/(app)/orgs/[orgId]/usage/page.tsx` |
| `/orgs` | `organizations` | `apps/web/app/(app)/orgs/page.tsx` |
| `/invitations/accept` | `invitation` | `apps/web/app/(auth)/invitations/accept/page.tsx` |
| `/login` | `login` | `apps/web/app/(auth)/login/page.tsx` |
| `/mfa` | `mfa` | `apps/web/app/(auth)/mfa/page.tsx` |
| `/reset` | `reset` | `apps/web/app/(auth)/reset/page.tsx` |
| `/signup` | `signup` | `apps/web/app/(auth)/signup/page.tsx` |
| `/verify` | `verify` | `apps/web/app/(auth)/verify/page.tsx` |

Reports & Schedules retains its working local schedule, queue, pause/resume, filter and report-detail specimens. Other routes demonstrate page-specific content and review dialogs. Form submissions, authentication, approvals, installations and connections never invoke a backend. All external actions require later production implementation.

Shared light/dark themes, mobile navigation, keyboard focus and form labels apply to every page. Layouts include sample populated, stale and partial data where appropriate; the component gallery retains reusable loading, empty and error specimens. This is route-level design coverage, not every production edge state.
