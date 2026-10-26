/** The daily report's sections, in the order of inital.md §13; `id` is the citation (`[S3]`). */
export const DAILY_SECTIONS = [
  { id: 'S1', key: 'summary', title: 'Executive summary' },
  { id: 'S2', key: 'health', title: 'Product health' },
  { id: 'S3', key: 'infrastructure', title: 'Infrastructure performance' },
  { id: 'S4', key: 'application', title: 'Application performance' },
  { id: 'S5', key: 'analytics', title: 'User analytics' },
  { id: 'S6', key: 'databases', title: 'Database health' },
  { id: 'S7', key: 'ads', title: 'Advertising performance' },
  { id: 'S8', key: 'deployments', title: 'Recent deployments' },
  { id: 'S9', key: 'availability', title: 'Security and availability events' },
  { id: 'S10', key: 'anomalies', title: 'Significant anomalies' },
  { id: 'S11', key: 'actions', title: 'Suggested actions' },
  { id: 'S12', key: 'coverage', title: 'Data coverage and missing sources' },
] as const;

/** `aws` (S13) is added only for products with a scoped AWS connection. */
export type SectionKey = (typeof DAILY_SECTIONS)[number]['key'] | 'aws';
