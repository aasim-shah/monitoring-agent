import type { AdapterResult, HttpLike } from './http.js';

export const GITHUB_DISPATCH_VERSION = '1';
const POLLS = 10;
const POLL_MS = 3000;

interface Run {
  id: number;
  html_url: string;
  status: string;
  created_at: string;
}

/**
 * GitHub `workflow_dispatch` (UC-16-07) for an allowlisted workflow and ref. Verification: a
 * run of that workflow appears within 30 s. A dispatched run cannot be recalled; cancel it in GitHub.
 */
export async function githubDispatch(
  http: HttpLike,
  input: {
    token: string;
    repo: string;
    workflow: string;
    ref: string;
    now: () => Date;
    sleep?: (ms: number) => Promise<void>;
    baseUrl?: string;
  },
): Promise<AdapterResult> {
  const base = input.baseUrl ?? 'https://api.github.com';
  const headers = {
    authorization: `Bearer ${input.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };
  const path = `${base}/repos/${input.repo}/actions/workflows/${encodeURIComponent(input.workflow)}`;
  const dispatchedAt = input.now().getTime();
  const res = await http.request(`${path}/dispatches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: input.ref }),
  });
  if (res.status !== 204)
    return { ok: false, error: `GitHub answered ${res.status}: ${res.text().slice(0, 200)}` };
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < POLLS; i++) {
    await sleep(POLL_MS);
    const list = await http.request(
      `${path}/runs?event=workflow_dispatch&branch=${encodeURIComponent(input.ref)}&per_page=5`,
      { headers },
    );
    if (list.status !== 200) continue;
    // Allow a little clock skew between GitHub and the platform.
    const run = list
      .json<{ workflow_runs?: Run[] }>()
      .workflow_runs?.find((r) => new Date(r.created_at).getTime() >= dispatchedAt - 5000);
    if (run)
      return {
        ok: true,
        result: { runId: run.id, url: run.html_url },
        verification: { runCreated: true, status: run.status },
      };
  }
  return { ok: false, error: 'No workflow run appeared within 30 s', verification: { runCreated: false } };
}
