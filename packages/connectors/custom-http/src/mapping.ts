/**
 * Minimal JSONPath for mappings: `$`, `.key`, `['key with spaces']`, `[index]`.
 * No filters or wildcards: mappings point at one value.
 */
export function readPath(doc: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error(`path ${path} must start with $`);
  const tokens = path.slice(1).match(/\.[A-Za-z_][\w-]*|\[\d+\]|\['(?:[^'\\]|\\.)*'\]/g) ?? [];
  if (tokens.join('') !== path.slice(1)) throw new Error(`unsupported path ${path}`);
  let cur: unknown = doc;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const key = t.startsWith('.')
      ? t.slice(1)
      : t.startsWith("['")
        ? t.slice(2, -2).replace(/\\(.)/g, '$1')
        : Number(t.slice(1, -1));
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
