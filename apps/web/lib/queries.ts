'use client';

import { unwrap } from '@pcp/api-client';
import { api } from './api';
import { useApiQuery } from './use-api-query';

export const useMe = () => useApiQuery(['me'], async () => unwrap(await api.GET('/api/v1/me')));

export const useOrganization = (orgId: string) =>
  useApiQuery(['org', orgId], async () =>
    unwrap(await api.GET('/api/v1/organizations/{orgId}', { params: { path: { orgId } } })),
  );

export const useProducts = (orgId: string) =>
  useApiQuery(['products', orgId], async () =>
    unwrap(await api.GET('/api/v1/organizations/{orgId}/products', { params: { path: { orgId } } })),
  );
