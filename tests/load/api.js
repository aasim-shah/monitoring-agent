// API read baseline (M19.2): authenticated dashboard reads under rising load.
//   docker run --rm -e BASE=http://host.docker.internal:18080 -e COOKIE=... -e PRODUCT_ID=... \
//     -v "$PWD/tests/load:/load" grafana/k6:0.57.0 run /load/api.js
// Never point this at a shared production host.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE;
const params = { headers: { cookie: __ENV.COOKIE } };

export const options = {
  scenarios: {
    reads: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '60s', target: 50 },
        { duration: '30s', target: 50 },
      ],
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  for (const path of [
    '/api/v1/me',
    `/api/v1/products/${__ENV.PRODUCT_ID}`,
    `/api/v1/products/${__ENV.PRODUCT_ID}/agents`,
    `/api/v1/products/${__ENV.PRODUCT_ID}/infrastructure`,
    `/api/v1/products/${__ENV.PRODUCT_ID}/incidents`,
  ]) {
    const res = http.get(`${BASE}${path}`, params);
    check(res, { [`${path.split('/').slice(-1)[0]} 200`]: (r) => r.status === 200 });
  }
}
