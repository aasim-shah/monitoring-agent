import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, ownerWithOrg } from '../../../test/auth-helpers.js';

// Regression: helpers computed TOTP from the wall clock while the app ran on a frozen
// test clock; once a file ran past one 30 s step, owners could not pass MFA.
let t: TestApp;
const frozen = new Date(Date.now() - 5 * 60_000);

beforeAll(async () => {
  t = await createTestApp({ clock: () => frozen });
});

afterAll(async () => {
  await t?.close();
});

it('owners pass MFA when the app clock is not the wall clock', async () => {
  const owner = await ownerWithOrg(t);
  await expect(createProduct(t, owner, 'Clocked')).resolves.toBeTruthy();
});
