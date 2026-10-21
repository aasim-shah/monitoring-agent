export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ReadinessReport {
  ok: boolean;
  results: CheckResult[];
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runChecks(checks: ReadinessCheck[], timeoutMs = 2000): Promise<ReadinessReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check }): Promise<CheckResult> => {
      try {
        await withTimeout(check(), timeoutMs);
        return { name, ok: true };
      } catch (err) {
        return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return { ok: results.every((r) => r.ok), results };
}
