import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function specRoutes() {
  const spec = read('AI_Product_Control_Plane_Architecture_and_Flows.md');
  const start = spec.indexOf('## 15. Public and Internal API Design');
  const end = spec.indexOf('## 16. ', start);
  const routes = [];
  for (const m of spec.slice(start, end).matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/gm)) {
    routes.push([m[1].toLowerCase(), m[2].replace(/:([A-Za-z]+)/g, '{$1}')]);
  }
  return routes;
}

const doc = parse(read('docs/architecture/openapi-v1.yaml'));

test('spec §15 routes parsed', () => {
  assert.ok(specRoutes().length >= 40);
});

test('every spec §15 route is in the OpenAPI document', () => {
  const missing = specRoutes().filter(([method, path]) => !doc.paths?.[path]?.[method]);
  assert.deepEqual(missing, []);
});

test('every operation declares security and a unique operationId', () => {
  const ids = new Set();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS.filter((m) => item[m])) {
      const op = item[method];
      assert.ok(Array.isArray(op.security), `${method.toUpperCase()} ${path} lacks security`);
      assert.ok(op.operationId, `${method.toUpperCase()} ${path} lacks operationId`);
      assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`);
      ids.add(op.operationId);
    }
  }
});

test('security schemes match the design', () => {
  const schemes = doc.components?.securitySchemes ?? {};
  assert.deepEqual(Object.keys(schemes).sort(), ['agentMtls', 'internalToken', 'sessionCookie', 'webhookSignature']);
  assert.equal(schemes.sessionCookie.in, 'cookie');
  assert.equal(schemes.sessionCookie.name, 'pcp_session');
  assert.equal(schemes.agentMtls.type, 'mutualTLS');
});
