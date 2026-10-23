/** Plain names for tools in the chat ("Checking host metrics…"). */
export const TOOL_LABELS: Record<string, string> = {
  listProducts: 'products',
  listAssets: 'assets',
  getAssetDetails: 'asset details',
  getDependencies: 'dependencies',
  getPotentialImpact: 'blast radius',
  getInfrastructureMetrics: 'host metrics',
  getApplicationErrors: 'log error counts',
  getConnectionHealth: 'integrations',
  getDatabaseHealth: 'database health',
  getIncidents: 'incidents',
  comparePeriods: 'period comparison',
  getWebsiteAvailability: 'website availability',
  getAnalyticsReport: 'analytics',
  getAdPerformance: 'ads',
  getDeployments: 'deployments',
  getApplicationMetrics: 'application metrics',
};

export const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
