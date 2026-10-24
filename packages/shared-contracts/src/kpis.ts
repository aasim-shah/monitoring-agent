/**
 * KPI catalog (spec §11.2, WB-09 UC-09-05, BR-09-03). Definitions live in code; the database holds
 * daily values only. Every KPI states what it counts, its unit, window, source, timezone, and caveats.
 */

/** Who a count is about. Counts of different populations are never added together (TC-09-05). */
export type Population = 'ga4_users' | 'ga4_events' | 'search' | 'play_users' | 'rate';

export interface KpiDefinition {
  key: string;
  label: string;
  definition: string;
  unit: 'count' | 'percent' | 'ratio' | 'position';
  /** How days combine over a range. Unique-user counts are averaged: summing days double-counts. */
  aggregation: 'sum' | 'mean';
  window: 'day';
  source: string;
  resourceType: string;
  metric: string;
  population: Population;
  timezone: string;
  caveats: string[];
  /** For rates and positions: lower is better. */
  lowerIsBetter?: boolean;
}

const ga4 = (
  metric: string,
  label: string,
  definition: string,
  unit: KpiDefinition['unit'],
  aggregation: KpiDefinition['aggregation'],
  population: Population,
  caveats: string[] = [],
): KpiDefinition => ({
  key: `ga4.${metric}`,
  label,
  definition,
  unit,
  aggregation,
  window: 'day',
  source: 'Google Analytics 4 (Data API)',
  resourceType: 'google_ga4_property',
  metric,
  population,
  timezone: "The GA4 property's reporting timezone",
  caveats: ['Today is partial: GA4 keeps processing for up to 48 hours.', ...caveats],
});

const search = (
  metric: string,
  label: string,
  definition: string,
  unit: KpiDefinition['unit'],
  aggregation: KpiDefinition['aggregation'],
  lowerIsBetter = false,
): KpiDefinition => ({
  key: `search.${metric}`,
  label,
  definition,
  unit,
  aggregation,
  window: 'day',
  source: 'Google Search Console (Search Analytics)',
  resourceType: 'google_search_console_site',
  metric,
  population: 'search',
  timezone: 'Pacific Time (Search Console reporting)',
  caveats: ['The last 3 days are provisional and usually rise.'],
  ...(lowerIsBetter ? { lowerIsBetter } : {}),
});

const play = (
  metric: string,
  label: string,
  definition: string,
  population: Population,
  unit: KpiDefinition['unit'] = 'ratio',
): KpiDefinition => ({
  key: `play.${metric}`,
  label,
  definition,
  unit,
  aggregation: 'mean',
  window: 'day',
  source: 'Google Play Developer Reporting (Android vitals)',
  resourceType: 'google_play_app',
  metric,
  population,
  timezone: 'Pacific Time (Play Console)',
  caveats: ['Play publishes a day about 2 days later.', 'Android only.'],
  ...(unit === 'ratio' ? { lowerIsBetter: true } : {}),
});

const LIST: KpiDefinition[] = [
  ga4(
    'activeUsers',
    'Active users',
    'Users who had an engaged session or opened the app that day.',
    'count',
    'mean',
    'ga4_users',
    [
      'A range shows the daily average: the same person on two days is one user each day.',
      'Not the number of signed-in accounts (GA4 "login" events are not authentication counts).',
    ],
  ),
  ga4(
    'newUsers',
    'New users',
    'Users who interacted with the site or app for the first time that day.',
    'count',
    'sum',
    'ga4_users',
  ),
  ga4('sessions', 'Sessions', 'Sessions that started that day.', 'count', 'sum', 'ga4_events'),
  ga4('screenPageViews', 'Views', 'Web pages and app screens viewed.', 'count', 'sum', 'ga4_events'),
  ga4('engagementRate', 'Engagement rate', 'Engaged sessions divided by sessions.', 'ratio', 'mean', 'rate'),
  ga4(
    'keyEvents',
    'Key events',
    'Events marked as key events in the property (formerly conversions).',
    'count',
    'sum',
    'ga4_events',
  ),
  search('clicks', 'Search clicks', 'Clicks from Google Search results to the site.', 'count', 'sum'),
  search(
    'impressions',
    'Search impressions',
    'Times a link to the site appeared in Google Search results.',
    'count',
    'sum',
  ),
  search('ctr', 'Click-through rate', 'Clicks divided by impressions.', 'ratio', 'mean'),
  search(
    'position',
    'Average position',
    'Average topmost position of the site in results.',
    'position',
    'mean',
    true,
  ),
  play(
    'playUserPerceivedCrashRate',
    'User-perceived crash rate',
    'Share of daily active users who had a crash while using the app.',
    'rate',
  ),
  play('playCrashRate', 'Crash rate', 'Share of daily active users who had any crash.', 'rate'),
  play(
    'playUserPerceivedAnrRate',
    'User-perceived ANR rate',
    'Share of daily active users who had an "app not responding" while using the app.',
    'rate',
  ),
  play('playAnrRate', 'ANR rate', 'Share of daily active users who had any "app not responding".', 'rate'),
  play(
    'playDistinctUsers',
    'Daily users (Play vitals)',
    'Distinct users counted by Android vitals that day.',
    'play_users',
    'count',
  ),
];

export const KPI_DEFINITIONS: Record<string, KpiDefinition> = Object.fromEntries(LIST.map((d) => [d.key, d]));

/** The KPIs read from one kind of resource, in catalog order. */
export const kpisFor = (resourceType: string) => LIST.filter((d) => d.resourceType === resourceType);

/** A range value by the KPI's rule; null when no day has a value (never zero for missing data). */
export function aggregate(def: KpiDefinition, values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!present.length) return null;
  const sum = present.reduce((a, b) => a + b, 0);
  return def.aggregation === 'sum' ? sum : sum / present.length;
}

/** A count tagged with its population, so only like counts can be added. */
export interface KpiValue<P extends Population> {
  readonly population: P;
  readonly value: number;
}

export const kpiValue = <P extends Population>(population: P, value: number): KpiValue<P> => ({
  population,
  value,
});

/** Adds counts of one population. Mixed populations fail to compile and, if forced, throw. */
export function sumKpis<P extends Population>(values: ReadonlyArray<KpiValue<P>>): KpiValue<P> {
  const population = values[0]?.population;
  if (population === undefined) throw new Error('sumKpis needs at least one value');
  if (values.some((v) => v.population !== population))
    throw new Error(`incomparable_kpis: ${[...new Set(values.map((v) => v.population))].join(' + ')}`);
  return { population, value: values.reduce((a, v) => a + v.value, 0) };
}
