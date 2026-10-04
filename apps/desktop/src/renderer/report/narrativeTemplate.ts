// The report narrative made from the project statistics without AI (BLD-7): the text the house
// report prints when nothing was saved, and the draft offered when cloud AI is off. With
// `todo`, the parts that need the author's judgement are left as [bracketed] prompts.
import type { NarrativeSectionId } from '@aio/schema';
import type { NarrativeFacts } from '@aio/project/export';
import { t } from '@aio/ui';

const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** 12,345 */
export const num = (n: number): string => nf.format(n);
/** 12.3 */
export const num1 = (n: number): string => nf1.format(n);

/** 24 Jan 2019 from an ISO date. */
export function longDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${t('house.and')} ${items.at(-1) ?? ''}`;
}

/** "3 photos, 1 3D model and 10 point clouds with 1,234 points". */
export function dataLine(d: NarrativeFacts['data']): string {
  const parts: string[] = [];
  const add = (key: string, count: number) => {
    if (count > 0) parts.push(t(key as Parameters<typeof t>[0], { count, n: num(count) }));
  };
  add('house.n.photos', d.photos);
  add('house.n.panoramas', d.panoramas);
  add('house.n.videos', d.videos);
  add('house.n.meshes', d.meshes);
  if (d.clouds > 0) {
    const clouds = t('house.n.clouds', { count: d.clouds, n: num(d.clouds) });
    parts.push(d.points > 0 ? `${clouds} (${t('house.n.points', { n: num(d.points) })})` : clouds);
  }
  add('house.n.rasters', d.rasters);
  add('house.n.vectors', d.vectors);
  return listOf(parts);
}

function dates(f: NarrativeFacts): string {
  return listOf(f.captures.map((c) => longDate(c.date)));
}

const sentences = (...s: (string | false | null | undefined)[]) =>
  s.filter((x): x is string => Boolean(x)).join(' ');

/** The narrative parts from the statistics. */
export function templateNarrative(
  f: NarrativeFacts,
  opts: { todo: boolean },
): Record<NarrativeSectionId, string> {
  const i = f.issues;
  const graded = i.bySeverity.filter((s) => s.count > 0);
  const issues = t('house.n.issues', { count: i.total, n: num(i.total) });
  const bySeverity = listOf(graded.map((s) => `${num(s.count)} ${s.label.toLowerCase()}`));
  const worst = i.worst.map((w) => `${w.code} (${w.title.toLowerCase()})`);
  const v = f.volumes;
  const r = f.road;
  const lastVol = v?.totalsM3.at(-1);
  const data = dataLine(f.data);

  const summary = [
    sentences(
      f.site
        ? t('narr.summary.introSite', { project: f.project, site: f.site, dates: dates(f) })
        : t('narr.summary.intro', { project: f.project, dates: dates(f) }),
      data && t('narr.summary.data', { data }),
      i.total > 0
        ? t('narr.summary.issues', { issues, bySeverity })
        : f.kind === 'inspection'
          ? t('narr.summary.noIssues')
          : null,
      worst.length > 0 && t('narr.summary.worst', { list: listOf(worst.slice(0, 3)) }),
      v &&
        lastVol !== undefined &&
        t('narr.summary.volumes', {
          total: num(lastVol),
          base: v.base.toLowerCase(),
          date: longDate(v.captures.at(-1) ?? ''),
          change: num(v.pileChangeM3),
        }),
      r?.networkPci != null &&
        t('narr.summary.road', { pci: num1(r.networkPci), rating: r.rating, km: num1(r.lengthKm) }),
    ),
    opts.todo ? t('narr.summary.todo') : '',
  ];

  const scale = f.severityScale.map((s) => s.label.toLowerCase());
  const method = [
    sentences(
      data && t('narr.method.capture', { dates: dates(f), data }),
      i.total > 0 &&
        t('narr.method.review', {
          levels: listOf(scale),
          placed: num(i.placed),
          total: num(i.total),
        }),
      t('narr.method.limits'),
    ),
    opts.todo ? t('narr.method.todo') : '',
  ];

  const findings = [
    i.total === 0
      ? t('narr.findings.none')
      : sentences(
          t('narr.summary.issues', { issues, bySeverity }),
          i.byClass.length > 0 &&
            t('narr.findings.class', {
              list: listOf(
                i.byClass.slice(0, 6).map((c) => `${c.label.toLowerCase()} ${num(c.count)}`),
              ),
            }),
          i.byZone.length > 1 &&
            t('narr.findings.zone', {
              list: listOf(i.byZone.slice(0, 6).map((z) => `${z.zone} ${num(z.count)}`)),
            }),
        ),
    i.uncertain > 0 ? t('narr.findings.uncertain', { n: num(i.uncertain) }) : '',
    opts.todo ? t('narr.findings.todo') : '',
  ];

  const join = (paras: string[]) => paras.filter(Boolean).join('\n\n');
  return { summary: join(summary), method: join(method), findings: join(findings) };
}
