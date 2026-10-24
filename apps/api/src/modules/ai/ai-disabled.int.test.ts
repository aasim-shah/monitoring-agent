import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, headers, ownerWithOrg } from '../../../test/auth-helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { AI_DISABLED: '1', PCP_AI_FAKE: '1' } });
});

afterAll(async () => {
  await t?.close();
});

describe('AI_DISABLED (M19.4, self-hosted)', () => {
  it('turns the assistant off for every organization and says so', async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/ai/conversations`,
      headers: headers(owner.cookie),
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ai_disabled', message: 'AI is turned off on this platform' });
  });
});
