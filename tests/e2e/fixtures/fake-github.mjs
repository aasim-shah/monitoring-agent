// A stand-in for api.github.com in the e2e stack, which has no internet (M7 exit gate).
// Answers only the read paths the GitHub connector calls, for owner "acme".
import { createServer } from 'node:http';
import { URL } from 'node:url';

const repo = (id, name) => ({
  id,
  full_name: `acme/${name}`,
  default_branch: 'main',
  private: true,
  visibility: 'private',
  archived: false,
  html_url: `https://github.com/acme/${name}`,
});
const REPOS = [repo(101, 'shop'), repo(102, 'api')];

const routes = [
  [/^\/user$/, () => ({ login: 'acme-bot' })],
  [/^\/users\/acme\/repos$/, () => REPOS],
  [/^\/repos\/acme\/([^/]+)$/, (m) => REPOS.find((r) => r.full_name === `acme/${m[1]}`) ?? null],
  [
    /^\/repos\/acme\/[^/]+\/actions\/workflows$/,
    () => ({ workflows: [{ id: 7, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }] }),
  ],
  [/^\/repos\/acme\/[^/]+\/deployments$/, () => []],
  [/^\/repos\/acme\/[^/]+\/releases$/, () => []],
];

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (pathname === '/healthz') return send(200, { ok: true });
  if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return send(401, { message: 'Bad credentials' });
  for (const [re, handler] of routes) {
    const m = re.exec(pathname);
    if (!m) continue;
    const body = handler(m);
    return body === null ? send(404, { message: 'Not Found' }) : send(200, body);
  }
  send(404, { message: 'Not Found' });
}).listen(8080);
