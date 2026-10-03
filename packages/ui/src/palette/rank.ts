export interface Command {
  id: string;
  title: string;
  /** Section heading in the palette: Navigate, Projects, Layers, Issues, Actions. */
  group: string;
  /** Extra words that match but are not shown. */
  keywords?: string[];
  /** Right-aligned hint: a shortcut, a count, a status. */
  hint?: string;
  run: () => void;
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1] ?? ' ';
  return /[\s_\-/.,·(]/.test(prev);
};

/**
 * Fuzzy subsequence score, higher is better; null when `query` is not a subsequence of `text`.
 * Rewards a prefix match, matches at word starts and consecutive runs.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 8;
    if (isBoundary(t, found)) s += 6;
    if (found === 0) s += 8;
    score += s;
    prev = found;
    ti = found + 1;
  }
  // Shorter texts with the same matches rank higher.
  return score - t.length * 0.01;
}

export function rankCommands(commands: readonly Command[], query: string, limit = 60): Command[] {
  if (!query.trim()) return commands.slice(0, limit);
  const scored: { c: Command; s: number }[] = [];
  for (const c of commands) {
    const candidates = [c.title, ...(c.keywords ?? [])];
    let best: number | null = null;
    for (const text of candidates) {
      const s = scoreMatch(query, text);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) scored.push({ c, s: best });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.c);
}
