import type { ReactNode } from 'react';

type Block =
  { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

/**
 * The Markdown subset `tools/release/notes.mjs` writes: `#` title (left out, the section names
 * the version), `##` group headings, `- ` bullets and plain lines. Text only, never HTML.
 */
export function parseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#\s/.test(line)) continue;
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', text: heading[1] ?? '' });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = blocks.at(-1);
      if (last?.kind === 'ul') last.items.push(bullet[1] ?? '');
      else blocks.push({ kind: 'ul', items: [bullet[1] ?? ''] });
      continue;
    }
    blocks.push({ kind: 'p', text: line });
  }
  return blocks;
}

export function ReleaseNotesView({ markdown, testId }: { markdown: string; testId?: string }) {
  const blocks = parseNotes(markdown);
  const out: ReactNode[] = blocks.map((b, i) => {
    const key = `${String(i)}-${b.kind}`;
    if (b.kind === 'h') return <h3 key={key}>{b.text}</h3>;
    if (b.kind === 'p') return <p key={key}>{b.text}</p>;
    return (
      <ul key={key}>
        {b.items.map((item, j) => (
          <li key={`${String(j)}-${item}`}>{item}</li>
        ))}
      </ul>
    );
  });
  return (
    <div className="release-notes" data-testid={testId}>
      {out.length ? out : <p className="faint">No release notes in this build.</p>}
    </div>
  );
}
