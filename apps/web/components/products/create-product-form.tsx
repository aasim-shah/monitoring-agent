'use client';

import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import { SimpleForm } from '../auth/simple-form';
import { api } from '@/lib/api';
import { splitList } from '@/lib/split-list';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  description: z.string().max(1000),
  domains: z.string(),
  repositories: z.string(),
});

export function CreateProductForm({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  return (
    <SimpleForm
      schema={schema}
      defaults={{ name: '', description: '', domains: '', repositories: '' }}
      fields={[
        { name: 'name', label: 'Product name' },
        { name: 'description', label: 'Description' },
        {
          name: 'domains',
          label: 'Domains',
          hint: 'Hostnames or URLs, comma-separated. Discovery hints, not proof of ownership.',
        },
        { name: 'repositories', label: 'Repositories', hint: 'GitHub URLs or owner/name, comma-separated' },
      ]}
      submitLabel="Create product"
      pendingLabel="Creating…"
      onSubmit={async (v) => {
        unwrap(
          await api.POST('/api/v1/organizations/{orgId}/products', {
            params: { path: { orgId } },
            body: {
              name: v.name,
              ...(v.description ? { description: v.description } : {}),
              domains: splitList(v.domains),
              repositories: splitList(v.repositories),
            },
          }),
        );
        await queryClient.invalidateQueries({ queryKey: ['products', orgId] });
      }}
    />
  );
}
