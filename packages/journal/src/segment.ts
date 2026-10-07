/** One line of a segment file, kept raw for hashing and exact error positions. */
export type SegmentLine =
  | { line: number; ok: true; raw: Record<string, unknown> }
  | { line: number; ok: false; error: string };

/** Split a `.jsonl` segment into numbered lines (1-based). Blank lines are skipped. */
export function readSegment(text: string): SegmentLine[] {
  const out: SegmentLine[] = [];
  text.split('\n').forEach((l, i) => {
    const s = l.trim();
    if (s === '') return;
    try {
      const raw = JSON.parse(s) as unknown;
      out.push(
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? { line: i + 1, ok: true, raw: raw as Record<string, unknown> }
          : { line: i + 1, ok: false, error: 'Not a JSON object.' },
      );
    } catch (e) {
      out.push({ line: i + 1, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return out;
}

/** The text of a segment: one JSON line per op, each ending with a newline. */
export function writeSegmentLine(op: unknown): string {
  return `${JSON.stringify(op)}\n`;
}
