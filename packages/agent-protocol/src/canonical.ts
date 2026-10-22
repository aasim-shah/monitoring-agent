/**
 * Canonical JSON for signed agent tasks (BR-03-07). Both the TypeScript signer and the Go
 * verifier must produce identical bytes, so the form is deliberately narrow:
 * - object keys sorted by UTF-16 code unit, at every depth; no whitespace;
 * - strings use JSON escapes, and every code unit from U+007F up is written as `\uXXXX`
 *   (lowercase hex), so the output is pure ASCII;
 * - numbers must be safe integers.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value))
        throw new Error(`canonical JSON allows only safe integers, got ${value}`);
      return String(value);
    case 'string':
      return JSON.stringify(value).replace(
        /[\u007f-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries.map(([k, v]) => `${canonicalJson(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON cannot encode ${typeof value}`);
  }
}
