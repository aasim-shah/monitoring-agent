'use client';

import { PageHeading } from '@/components/shell/page-heading';

import Link from 'next/link';
import { ArrowUpRight, Building2, Plus, ShieldCheck } from 'lucide-react';
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
    <main className="portal-main portal-organizations">
      <PageHeading
        title="Your workspaces"
        description="Choose an organization to manage your products, people, and connected operations."
        eyebrow="Workspace"
      />
      <div className="portal-organization-grid">
        <section aria-labelledby="organizations-title">
          <div className="portal-section-heading">
            <h2 id="organizations-title">Organizations</h2>
            {me.data && <span className="portal-count">{me.data.memberships.length}</span>}
          </div>
          {me.isPending ? <Loading label="Loading organizations" /> : null}
          {me.visibleError ? <ErrorState error={me.visibleError} onRetry={() => me.refetch()} /> : null}
          {me.data && me.data.memberships.length === 0 ? (
            <Empty
              title="No organizations yet"
              description="Create one, or accept an invitation from your team."
            />
          ) : null}
          <ul className="portal-organization-list">
            {me.data?.memberships.map((m) => (
              <li key={m.organizationId}>
                <Link className="portal-organization-link" href={`/orgs/${m.organizationId}`}>
                  <Card className="portal-organization-card">
                    <span className="portal-organization-icon">
                      <Building2 size={22} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words font-semibold">{m.organizationName}</h3>
                      <p className="mt-1 text-[13px] text-muted-foreground">Open workspace</p>
                    </div>
                    <Badge>{m.role}</Badge>
                    <ArrowUpRight size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <Card className="portal-create-organization h-fit">
          <span className="portal-organization-icon">
            <Plus size={22} aria-hidden="true" />
          </span>
          <div>
            <CardTitle>New organization</CardTitle>
            <CardDescription>
              You become its owner. Owners must set up two-factor authentication.
            </CardDescription>
          </div>
          <CreateOrganizationForm />
          <p className="portal-organization-note">
            <ShieldCheck size={16} aria-hidden="true" />
            Your workspace keeps product data and team access together.
          </p>
        </Card>
      </div>
    </main>
  );
}
