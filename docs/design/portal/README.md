# Product Control Plane — Portal design system

Status: design proposal, based on the approved Lumen Orange landing page. This package specifies the portal; it does not change the production application. Preview data is illustrative and all actions are local to the prototype.

## Foundations

Use the existing `@lumen/react`, `@lumen/tokens`, and `@lumen/icons/react` packages when implementing. Import Lumen styles once. Set `data-brand="orange"`. The accompanying `portal.css` is a standalone reference stylesheet for the design preview, not a replacement component library. Use semantic variables so both schemes share components.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | #F2F2F7 | #000000 |
| Surface | #FFFFFF | #1C1C1E |
| Raised surface | #FFFFFF | #2C2C2E |
| Primary label | #000000 | #FFFFFF |
| Secondary label | #626268 | #B0B0B8 |
| Separator | rgba(60,60,67,.14) | rgba(235,235,245,.14) |
| Accent | #C95100 | #FF9F0A |
| On accent | #FFFFFF | #000000 |
| Accent tint | rgba(201,81,0,.08) | rgba(255,159,10,.12) |
| Success text | #15803D | #30D158 |
| Warning text | #8C5700 | #FFCC00 |
| Danger text | #B91C1C | #FF6961 |

Secondary text is intentionally opaque to remain readable in dense tables. Status colors have a text label and icon/dot; never rely on hue alone. Orange marks a current destination, selection, or primary action. The warm blend is limited to the page introduction, empty states and AI context; never behind tables, charts, fields, or error messages.

System sans follows Lumen: display 48/52 (marketing only), largeTitle 34/41, title1 28/34, title2 22/28, title3 20/25, headline/body 17/22, subheadline 15/20, footnote 13/18, caption 12/16. Use 28/34 page titles, 20/25 section titles, 15/20 data cells, 13/18 table headers and metadata. Use tabular numerals for metrics, dates, and times. Keep body descriptions at 17/24. Icons are Lumen Rounded, 18–20px in controls, 24px in circular feature holders.

4px spacing grid: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Desktop main padding 32; tablet 24; phone 16. Content max width 1080; forms 680. Sidebar 240. Card radius 24, grouped lists 20, fields 10, buttons 12, badge capsule, dialogs 28. One visible filled action per task context.

## Navigation and shell

Keep the product wordmark as text. A persistent sidebar contains product context, product destinations and a collapsible Workspace group. Keep every existing route and permission check. Use the same exact active-route match as the application; never highlight Members & Roles while Reports & Schedules is open. Organization and product scope stay visible. Product names are selectable; environment scope appears only on pages whose data is actually environment-scoped.

Group product routes into Observe (health, assets, infrastructure, websites/APIs, mobile, databases, analytics), Operate (incidents, AI, reports, automations), and Setup (integrations, agents). Workspace group contains overview, members, usage, settings, notifications and audit. Do not create a second product Audit Log destination: the existing route is organization-scoped and remains under Workspace. Under 1024px use a menu drawer with backdrop, Escape dismissal and focus management; never drop routes silently. A 52–64px topbar holds breadcrumbs and appearance control. Navigation changes context; do not silently reset unsaved work.

## Component contracts

| Pattern | Lumen primitive | Behavior |
| --- | --- | --- |
| Primary / secondary / destructive action | Button | Filled / gray or plain / danger; pending preserves width; minimum hit target 44px |
| Navigation item | Sidebar | 44px hit target, icon and label, tint + aria-current on active route |
| Search/filter | SearchField, Select, Chip | Visible label; filter state survives viewing a row; clear control and result count |
| Form field | TextField, Select, FormSection | Label 6px above; help or corrective error 6px below; errors linked with aria-describedby |
| Status badge | Badge | Text plus dot/icon; status and freshness remain separate |
| Data table | Table | 40px header, 64px standard row (52px compact); sticky header for long lists; right-align numeric data; row actions have specific labels |
| Card | Card | 24px padding; title and useful action; avoid cards within cards |
| Feedback | Alert, useToast | Persistent inline errors; polite success status; assertive failures only when urgent |
| Dialog / drawer | Dialog, Sheet | Named, focus trapped, Escape, return focus, visible close, mobile scroll; confirm irreversible deletion |
| Loading | Skeleton | Match the eventual geometry and mark the region busy |
| No data | EmptyState | Explain why and provide an authorized next action |
| Unavailable source | Alert + Badge | Show reason, last available time, and reconnect/retry if permitted; never render as zero |
| Evidence | List + Popover/Sheet | Source, collection time, scope, known gaps and uncertainty; cite the actual record |
| Chart | SVG/Recharts with semantic chart tokens | Unit, source, period and timezone; null values make gaps; table alternative, labels and tooltip keyboard access |

## Product patterns

Reports & Schedules: page heading and one Add schedule action, a concise latest-report summary, schedule list, searchable/filterable history. Keep report date separate from generated time. Display report versions individually, including deferred/disabled narrative states. Verified summary means checked against evidence; do not imply all sources are available. Date filtering is based on report local day. Search matches schedule or date. Schedule row shows daily local time, timezone, delivery destinations, next run local and UTC; paused rows show no next run. Run now is asynchronous: show queued, then generated only after confirmation. Retain pause/resume and deletion with explicit confirmation. All mutations remain permission-gated server-side in implementation.

Schedule form: name, local time, timezone, notification channels, recipients (up to 10), and next-run preview. Cover the previous complete local day; do not hard-code a 24-hour window across DST. Never calculate a live next run from the viewer's timezone. Example preview labels its fixed dates. Prototype supports Asia/Karachi only and says so explicitly.

Health: health state, observed value, unit, source and freshness. Do not merge service availability with product health. Incidents: severity, lifecycle and acknowledgment are independent labels. AI: question, cited answer, source list, gaps and proposed action review. Approvals: exact target, expected effect, permissions and execution record; high-impact action receives explicit confirmation. Analytics: no summation of unique-user counts and no fabricated zero on missing days.

## Motion and accessibility

Use Lumen 100ms press, 160ms hover, 240ms transitions, 360ms overlays, 500ms major entry. GSAP is suitable for one-time page/context entrances; data refreshes should not continually animate. Reduced motion removes travel, loops and stagger. No decorative looping animation inside data tables. Keyboard focus uses 3px accent halo with 2px offset. Visible labels, semantic tables, native buttons/selects/dialogs, and 44px targets. Color contrast target WCAG AA. Focus moves to validation errors after failed submission; live updates do not steal focus.

## Rollout

1. Adopt semantic tokens and appearance at the application root; verify auth screens too.
2. Build the shared shell, status and table primitives using Lumen.
3. Migrate Reports & Schedules preserving API and permission semantics.
4. Apply patterns to health, integrations, incidents, AI and approvals.
5. Verify loading, empty, partial, failure and populated states in both schemes and at 390px, tablet and desktop. Validate keyboard, focus restoration, long labels and permission-limited roles.

The preview's Design system tab contains a visual inventory of foundations, controls, statuses, forms, chart and feedback patterns. Its Portal preview tab demonstrates Reports & Schedules and a working local schedule dialog, run queue feedback, pause/resume, filters, report detail and confirmation.

## Control refinement

Controls use 44px height and 20px horizontal button padding; quiet row actions share the same hit target. Selects use a reserved 44px trailing area for the chevron, 14px leading inset, native keyboard selection and scheme-aware menus. Search reserves 44px for its icon. Dialogs use 32px padding (24px on phones), 24px field-group spacing and a separated footer with 20px vertical / 32px horizontal inset. A scoped preview root prevents host CSS resets from removing control and dialog padding. Alerts use a neutral surface, a tinted circular status icon, a short title, an actionable explanation, and a recovery button when applicable.

## Connected page coverage

The preview now covers all 34 existing portal routes, including authentication and detail pages. See [PAGES.md](PAGES.md) for the source-to-design map. `pages.json` records the page-specific design content; `preview.html` contains the connected interactive prototype. Use All pages for account and detail screens and the sidebar for primary portal destinations.

## Next.js adoption

The approved system is applied to the application shell in `apps/web/app/(app)/portal.css`. `PortalNavigation` groups the permission-filtered existing route lists, `PortalTheme` persists appearance, and the organization layout retains its original data and tenant guards. Shared UI primitives expose scoped `pcp-*` hooks; dialogs use `portal-dialog` because Radix portals render outside the application wrapper. Auth pages reuse the same palette and controls. Existing page data, permissions and mutations remain authoritative; illustrative prototype rows and metrics are never imported into production.

### Page composition adoption

Portal headings are now structured page components across workspace, product and detail screens. Agents and Infrastructure render real-data summary cards. Reports has a latest-report / next-delivery composition and combined history search/status filters. Analytics and Mobile share a heading/range composition. AI has an empty conversation introduction with question suggestions and a separate conversation rail. Integrations use provider cards; operational detail sections, asset tabs and timeline surfaces follow the portal spacing system. Data sources and permission checks remain those of the original routes. Light is the default when no explicit appearance preference has been saved; dark remains an opt-in choice.
