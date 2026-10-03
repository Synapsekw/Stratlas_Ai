import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Collects facts during an import and renders IMPORT-REPORT.md. */
export class ImportReport {
  readonly counts = new Map<string, number>();
  readonly warnings: string[] = [];
  readonly notes: string[] = [];
  readonly sections: { title: string; lines: string[] }[] = [];

  constructor(readonly title: string) {}

  count(key: string, n = 1) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  warn(msg: string) {
    this.warnings.push(msg);
  }

  note(msg: string) {
    this.notes.push(msg);
  }

  section(title: string, lines: string[]) {
    this.sections.push({ title, lines });
  }

  toMarkdown(root: string): string {
    const sizes = folderSizes(root);
    const total = [...sizes.values()].reduce((a, b) => a + b.bytes, 0);
    const out: string[] = [`# ${this.title}`, ''];
    out.push(`Package: \`${root}\``, '');
    out.push('## Counts', '', '| Item | Count |', '| --- | ---: |');
    for (const [k, v] of this.counts) out.push(`| ${k} | ${v} |`);
    out.push('', '## Sizes', '', '| Folder | Files | Size |', '| --- | ---: | ---: |');
    for (const [k, v] of [...sizes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`| ${k} | ${v.files} | ${formatBytes(v.bytes)} |`);
    }
    out.push(
      `| **total** | ${[...sizes.values()].reduce((a, b) => a + b.files, 0)} | **${formatBytes(total)}** |`,
      '',
    );
    for (const s of this.sections) out.push(`## ${s.title}`, '', ...s.lines, '');
    if (this.notes.length) out.push('## Notes', '', ...this.notes.map((n) => `- ${n}`), '');
    out.push('## Warnings', '');
    out.push(...(this.warnings.length ? this.warnings.map((w) => `- ${w}`) : ['None.']), '');
    return out.join('\n');
  }
}

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

/** Bytes and file count per top-level entry (files at the root are grouped as "."). */
export function folderSizes(root: string): Map<string, { files: number; bytes: number }> {
  const res = new Map<string, { files: number; bytes: number }>();
  const walk = (dir: string, top: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, top || e.name);
      else if (!e.name.endsWith('.partial') && e.name !== 'IMPORT-REPORT.md') {
        const key = top || '.';
        const cur = res.get(key) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += statSync(p).size;
        res.set(key, cur);
      }
    }
  };
  walk(root, '');
  return res;
}
