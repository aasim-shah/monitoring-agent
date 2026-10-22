import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_PERMISSION, SESSION_ONLY, TENANT_SCOPE } from '../../src/common/decorators.js';
import { createTestApp, type TestApp } from '../app-factory.js';
import { createProduct, headers, ownerWithOrg } from '../auth-helpers.js';

// Nest's route metadata keys (@nestjs/common/constants).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

interface Route {
  method: string;
  path: string;
  isPublic: boolean;
  sessionOnly: boolean;
  permission?: string;
  scope?: unknown;
}

let t: TestApp;

function routes(): Route[] {
  const discovery = t.app.get(DiscoveryService);
  const scanner = t.app.get(MetadataScanner);
  const reflector = t.app.get(Reflector);
  const out: Route[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const base = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
    for (const name of scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
      const handler = instance[name as keyof typeof instance] as unknown as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
      const targets = [handler as never, metatype as never];
      out.push({
        method,
        path:
          `/${[base, String(path)].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/',
        isPublic: Boolean(reflector.getAllAndOverride(IS_PUBLIC, targets)),
        sessionOnly: Boolean(reflector.getAllAndOverride(SESSION_ONLY, targets)),
        permission: reflector.getAllAndOverride(REQUIRED_PERMISSION, targets),
        scope: reflector.getAllAndOverride(TENANT_SCOPE, targets),
      });
    }
  }
  return out;
}

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('route enumeration (Review Focus #5)', () => {
  it('finds the API routes', () => {
    expect(routes().length).toBeGreaterThanOrEqual(15);
  });

  it('every route is @Public, @SessionOnly, or has @RequirePermission with @TenantScope', () => {
    const unguarded = routes()
      .filter((r) => !r.isPublic && !r.sessionOnly && !(r.permission && r.scope))
      .map((r) => `${r.method} ${r.path}`);
    expect(unguarded).toEqual([]);
  });

  it('a tenant-B owner gets 404 on every tenant-A resource route', async () => {
    const a = await ownerWithOrg(t, 'Tenant A');
    const productA = await createProduct(t, a);
    const env = await t.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productA}/environments`,
      headers: headers(a.cookie),
      payload: { name: 'Production' },
    });
    const conn = await t.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${a.orgId}/connections`,
      headers: headers(a.cookie),
      payload: { provider: 'mock', displayName: 'Mock', executionLocation: 'cloud', config: {} },
    });
    const ids: Record<string, string> = {
      id: (conn.json() as { id: string }).id,
      orgId: a.orgId,
      productId: productA,
      environmentId: (env.json() as { id: string }).id,
      memberId: randomUUID(),
    };
    const b = await ownerWithOrg(t, 'Tenant B');

    const tenantRoutes = routes().filter((r) => !r.isPublic && !r.sessionOnly);
    expect(tenantRoutes.length).toBeGreaterThan(0);
    for (const r of tenantRoutes) {
      const url = r.path.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? randomUUID());
      const res = await t.app.inject({
        method: r.method as 'GET',
        url,
        headers: headers(b.cookie),
        ...(r.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(404);
    }
  });
});
