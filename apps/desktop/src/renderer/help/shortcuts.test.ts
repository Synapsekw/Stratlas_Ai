/**
 * The guide's keyboard chapter (Settings, Keyboard shortcuts) is the shortcut registry
 * (packages/ui/src/shortcuts.ts) written out: same scopes, keys and words as Settings, Keyboard.
 * After changing the registry, regenerate it with
 *   STRATLAS_UPDATE_GUIDE_SHORTCUTS=1 pnpm vitest run apps/desktop/src/renderer/help/shortcuts.test.ts
 * then `pnpm prettier --write docs/guide/12-settings.md`.
 */
import { keyLabel, SHORTCUT_SCOPES, SHORTCUTS, t } from '@aio/ui';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const file = join(import.meta.dirname, '../../../../../docs/guide/12-settings.md');
const HEADING = '## Keyboard shortcuts';

/** The chapter section as the registry has it (Windows key names; the intro covers the Mac). */
function shortcutsSection(): string {
  const out = [
    HEADING,
    '',
    'The same list is in **Settings**, **Keyboard**. On a Mac, Ctrl is ⌘ (Command) and Alt is ⌥ (Option); {product} shows the Mac keys there and in its tool tips.',
  ];
  for (const { scope, label } of SHORTCUT_SCOPES) {
    const rows = SHORTCUTS.filter((s) => s.scope === scope);
    if (rows.length === 0) continue;
    out.push('', `### ${t(label)}`, '', '| Keys | Does |', '| --- | --- |');
    for (const s of rows) {
      const keys = s.keys.map((k) => keyLabel(k, false)).join(', ');
      out.push(`| ${keys} | ${t(s.label).replaceAll('|', '\\|')} |`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** The section from its heading to the next level-2 heading or the end of the chapter. */
function section(md: string): { start: number; end: number } {
  const start = md.indexOf(`\n${HEADING}\n`) + 1;
  if (start === 0) throw new Error(`${HEADING} is missing from 12-settings.md`);
  const next = md.indexOf('\n## ', start + HEADING.length);
  return { start, end: next < 0 ? md.length : next + 1 };
}

/** Table cells without their padding, so Prettier's column alignment does not matter. */
function normalise(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => {
      if (!l.startsWith('|')) return l.trimEnd();
      const cells = l
        .slice(1, l.endsWith('|') ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim());
      return cells.every((c) => /^:?-+:?$/.test(c)) ? '|---|' : cells.join(' | ');
    })
    .filter((l, i, all) => l !== '' || all[i - 1] !== '');
}

describe('guide keyboard chapter', () => {
  it('lists exactly the shortcuts of the registry', () => {
    const md = readFileSync(file, 'utf8');
    const { start, end } = section(md);
    const want = shortcutsSection();
    if (process.env.STRATLAS_UPDATE_GUIDE_SHORTCUTS === '1') {
      const tail = md.slice(end);
      writeFileSync(file, md.slice(0, start) + want + (tail ? `\n${tail}` : ''));
      return;
    }
    expect(normalise(md.slice(start, end))).toEqual(normalise(want));
  });
});
