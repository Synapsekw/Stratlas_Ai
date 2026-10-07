import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Test helper. Every file under `<root>/journal`, keyed by its project-relative path with forward slashes. */
export function loadJournalFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'journal'));
  return out;
}
