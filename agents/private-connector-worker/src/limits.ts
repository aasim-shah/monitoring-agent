/** BR-07-04: results sent to the control plane are at most 256 KB. */
export const MAX_RESULT_BYTES = 256 * 1024;

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** The array holding the most bytes, anywhere in the value. */
function largestArray(value: unknown): unknown[] | undefined {
  let best: unknown[] | undefined;
  let bestSize = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      const s = size(v);
      if (s > bestSize && v.length > 1) {
        best = v;
        bestSize = s;
      }
      v.forEach(walk);
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return best;
}

/** Halves the largest arrays until the result fits, then marks it `truncated`. */
export function capResult<T>(result: T, limit = MAX_RESULT_BYTES): T | (T & { truncated: true }) {
  if (size(result) <= limit) return result;
  const copy = structuredClone(result) as Record<string, unknown>;
  copy.truncated = true;
  while (size(copy) > limit) {
    const arr = largestArray(copy);
    if (!arr) return { truncated: true, error: 'result too large' } as unknown as T & { truncated: true };
    arr.length = Math.floor(arr.length / 2);
  }
  return copy as T & { truncated: true };
}
