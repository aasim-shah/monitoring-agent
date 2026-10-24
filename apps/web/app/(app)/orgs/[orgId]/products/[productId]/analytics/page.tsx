'use client';

import { useParams } from 'next/navigation';
import { KpiSources } from '@/components/analytics/kpi-page';

export default function AnalyticsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  return (
    <KpiSources
      orgId={orgId}
      productId={productId}
      title="Analytics & Ads"
      intro="Daily GA4 traffic and Search Console results for this product. Missing days show as no data, never zero; today is partial."
      resourceTypes={['google_ga4_property', 'google_search_console_site']}
      chartKeys={{ google_ga4_property: 'ga4.activeUsers', google_search_console_site: 'search.clicks' }}
      emptyHint="GA4 properties and Search Console sites"
    >
      {() => (
        <section aria-label="Advertising" className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Advertising</h2>
          <p className="text-sm text-muted-foreground">
            Google Ads: pending platform approval. Ads data needs the platform&apos;s Google Ads developer
            token; nothing is read until then, and campaigns are never changed.
          </p>
        </section>
      )}
    </KpiSources>
  );
}
