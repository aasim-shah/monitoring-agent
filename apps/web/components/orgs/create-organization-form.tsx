'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import { SimpleForm } from '../auth/simple-form';
import { api } from '@/lib/api';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  timezone: z.string().min(1),
});

export function CreateOrganizationForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const timezone = typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <SimpleForm
      schema={schema}
      defaults={{ name: '', timezone }}
      fields={[
        { name: 'name', label: 'Organization name' },
        { name: 'timezone', label: 'Timezone', hint: 'IANA name, e.g. Europe/Berlin. Used for reports.' },
      ]}
      submitLabel="Create organization"
      pendingLabel="Creating…"
      onSubmit={async (body) => {
        const org = unwrap(await api.POST('/api/v1/organizations', { body }));
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        router.push(`/orgs/${org.id}`);
      }}
    />
  );
}
