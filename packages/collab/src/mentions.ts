/** A person @mentions can name. */
export interface Mentionable {
  actor: string;
  name: string;
  initials: string;
}

const LETTER = /[\p{L}\p{N}_]/u;

/** The handles a person answers to: full name, first name, initials (case does not matter). */
export function handlesOf(m: Mentionable): string[] {
  const first = m.name.trim().split(/\s+/)[0] ?? '';
  return [...new Set([m.name.trim(), first, m.initials].filter((h) => h.length > 0))];
}

/** A first name shared by two people names neither of them. */
function uniqueHandles(people: readonly Mentionable[]): { handle: string; actor: string }[] {
  const owners = new Map<string, Set<string>>();
  for (const p of people)
    for (const h of handlesOf(p)) {
      const k = h.toLocaleLowerCase();
      owners.set(k, (owners.get(k) ?? new Set()).add(p.actor));
    }
  return [...owners]
    .filter(([, actors]) => actors.size === 1)
    .map(([handle, actors]) => ({ handle, actor: [...actors][0] ?? '' }))
    .sort((a, b) => b.handle.length - a.handle.length);
}

/**
 * The people a comment @mentions: `@Omar`, `@Omar Sample` or `@OS`, any script (Arabic names
 * too), longest handle first, each person once. A handle must end at a word boundary, so
 * `@Omarx` names nobody.
 */
export function parseMentions(text: string, people: readonly Mentionable[]): string[] {
  const handles = uniqueHandles(people);
  const lower = text.toLocaleLowerCase();
  const found = new Set<string>();
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    const before = i > 0 ? lower.charAt(i - 1) : '';
    if (before && LETTER.test(before)) continue; // an email address, not a mention
    for (const { handle, actor } of handles) {
      if (!lower.startsWith(handle, i + 1)) continue;
      const after = lower.charAt(i + 1 + handle.length);
      if (after && LETTER.test(after)) continue;
      found.add(actor);
      break;
    }
  }
  return [...found];
}

/** People whose handles start with what follows the last `@` being typed (for the picker). */
export function mentionCandidates(
  draft: string,
  people: readonly Mentionable[],
): { query: string; people: Mentionable[] } | null {
  const at = draft.lastIndexOf('@');
  if (at < 0) return null;
  const query = draft.slice(at + 1);
  if (/\s{2,}|\n/.test(query) || query.length > 40) return null;
  const q = query.toLocaleLowerCase();
  const hits = people.filter((p) => handlesOf(p).some((h) => h.toLocaleLowerCase().startsWith(q)));
  return hits.length ? { query, people: hits } : null;
}
