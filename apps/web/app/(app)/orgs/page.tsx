'use client';

import Link from 'next/link';
import { CreateOrganizationForm } from '@/components/orgs/create-organization-form';
import { Empty } from '@/components/states/empty';
import { ErrorState } from '@/components/states/error-state';
import { Loading } from '@/components/states/loading';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/queries';

export default function OrganizationsPage() {
  const me = useMe();
  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-8 md:grid-cols-[1fr_320px]">
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">Organizations</h1>
        {me.isPending ? <Loading label="Loading organizations" /> : null}
        {me.visibleError ? <ErrorState error={me.visibleError} onRetry={() => me.refetch()} /> : null}
        {me.data && me.data.memberships.length === 0 ? (
          <Empty
            title="No organizations yet"
            description="Create one, or accept an invitation from your team."
          />
        ) : null}
        <ul className="space-y-2">
          {me.data?.memberships.map((m) => (
            <li key={m.organizationId}>
              <Link href={`/orgs/${m.organizationId}`}>
                <Card className="flex items-center justify-between p-4 hover:bg-muted">
                  <span className="font-medium">{m.organizationName}</span>
                  <Badge>{m.role}</Badge>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <Card className="h-fit space-y-4">
        <div>
          <CardTitle>New organization</CardTitle>
          <CardDescription>
            You become its owner. Owners must set up two-factor authentication.
          </CardDescription>
        </div>
        <CreateOrganizationForm />
      </Card>
    </main>
  );
}
