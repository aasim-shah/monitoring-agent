'use client';

import { useParams } from 'next/navigation';
import { KpiSources } from '@/components/analytics/kpi-page';

export default function MobilePage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  return (
    <KpiSources
      orgId={orgId}
      productId={productId}
      title="Mobile Apps & SDKs"
      intro="Android vitals from Google Play and the Firebase apps of this product. Play publishes a day about 2 days later."
      resourceTypes={['google_play_app']}
      chartKeys={{ google_play_app: 'play.playUserPerceivedCrashRate' }}
      emptyHint="Play apps and Firebase apps"
    >
      {(data) => {
        const apps = data.resources.filter((r) => r.resourceType === 'google_firebase_app');
        return (
          <>
            <section
              aria-label="Firebase apps"
              className="space-y-2 rounded-lg border border-border bg-card p-4"
            >
              <h2 className="text-sm font-semibold">Firebase apps</h2>
              {apps.length ? (
                <ul className="text-sm">
                  {apps.map((a) => (
                    <li key={a.externalId}>{a.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No Firebase app is scoped to this product.</p>
              )}
              <p className="text-xs text-muted-foreground">
                Crash-free users and app start times need the Crashlytics and Performance exports in BigQuery;
                they are not read yet.
              </p>
            </section>
            <section aria-label="SDK" className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">In-app SDK</h2>
              <p className="text-sm text-muted-foreground">
                SDK not available yet. Until then, mobile health comes from Play vitals and Firebase.
              </p>
            </section>
          </>
        );
      }}
    </KpiSources>
  );
}
