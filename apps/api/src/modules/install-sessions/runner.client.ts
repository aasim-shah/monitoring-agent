import { ApiException } from '../../common/errors.js';

export interface RunnerCreate {
  sessionId: string;
  organizationId: string;
  mode: 'key' | 'password';
  hosts: Array<{ id: string; host: string; port: number; username: string }>;
  install: { token: string; controlUrl: string; downloadUrl: string; installScriptUrl: string };
  expiresAt: string;
}

/** The installer runner's internal API (apps/installer-runner); secrets go there and nowhere else. */
export interface InstallerRunner {
  create(req: RunnerCreate): Promise<{ publicKey: string }>;
  connect(sessionId: string, password?: string): Promise<void>;
  confirm(sessionId: string, hostId: string, fingerprint: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

const unavailable = () =>
  new ApiException(503, 'installer_unavailable', 'Assisted install is not available right now');

export class HttpInstallerRunner implements InstallerRunner {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async create(req: RunnerCreate) {
    return (await this.call('POST', '/sessions', req)) as { publicKey: string };
  }

  async connect(sessionId: string, password?: string) {
    await this.call('POST', `/sessions/${sessionId}/connect`, password ? { password } : {});
  }

  async confirm(sessionId: string, hostId: string, fingerprint: string) {
    await this.call('POST', `/sessions/${sessionId}/hosts/${hostId}/confirm`, { fingerprint });
  }

  async abort(sessionId: string) {
    await this.call('DELETE', `/sessions/${sessionId}`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'x-internal-token': this.token, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unavailable();
    }
    const text = await res.text();
    if (res.status === 409) throw new ApiException(409, 'install_conflict', parseMessage(text));
    if (res.status === 404)
      throw new ApiException(409, 'install_session_gone', 'This session ended; start a new one');
    if (!res.ok) throw unavailable();
    return text ? JSON.parse(text) : {};
  }
}

function parseMessage(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? 'Conflict';
  } catch {
    return 'Conflict';
  }
}

/** When the runner is not configured, every call is a 503. */
export class MissingInstallerRunner implements InstallerRunner {
  async create(): Promise<{ publicKey: string }> {
    throw unavailable();
  }
  async connect() {
    throw unavailable();
  }
  async confirm() {
    throw unavailable();
  }
  async abort() {}
}
