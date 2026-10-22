/** "a.com, b.com" or one per line → trimmed, non-empty entries. */
export const splitList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
