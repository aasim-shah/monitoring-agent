/** Small counts ("2 hosts") come from reading lists, not from data values. */
const SMALL_COUNT = 10;

const EXCLUDE = [
  /\[E\d+\]/g, // citations
  /\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, // dates and ISO timestamps
  /\b\d{1,2}:\d{2}(:\d{2})?\b/g, // times
  /\bFinding \d+\b/gi, // finding numbers
];

const NUMBER = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/** Models write typographic hyphens, minus signs, and narrow spaces; read them as plain ones. */
const normalize = (text: string) =>
  text.replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00a0\u2009\u202f]/g, ' ');

function numbersIn(text: string): Array<{ value: number; decimals: number; raw: string }> {
  let t = normalize(text);
  for (const re of EXCLUDE) t = t.replace(re, ' ');
  return [...t.matchAll(NUMBER)].map((m) => {
    const raw = m[0].replace(/,/g, '');
    return { value: Number(raw), decimals: raw.includes('.') ? raw.split('.')[1]!.length : 0, raw: m[0] };
  });
}

/**
 * BR-14-06: every cited evidence ID exists and every number in the answer appears in the
 * evidence or the question (rounded to the precision written), ignoring dates, times, and
 * finding numbers.
 */
export function validateAnswer(
  text: string,
  evidence: Array<{ id: string; json: string }>,
  question: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const ids = new Set(evidence.map((e) => e.id));
  for (const m of new Set([...text.matchAll(/\[(E\d+)\]/g)].map((x) => x[1]!)))
    if (!ids.has(m)) problems.push(`${m} is not an evidence ID`);
  const known = numbersIn(evidence.map((e) => e.json).join(' ') + ' ' + question).map((n) => n.value);
  for (const n of numbersIn(text)) {
    if (Number.isInteger(n.value) && Math.abs(n.value) <= SMALL_COUNT) continue;
    const f = 10 ** n.decimals;
    const supported = known.some((k) => Math.round(k * f) / f === n.value || k === n.value);
    const label = n.raw.replace(/,/g, '');
    if (!supported && !problems.includes(`${label} does not appear in the evidence`))
      problems.push(`${label} does not appear in the evidence`);
  }
  return { ok: problems.length === 0, problems };
}
