// The sections of the house report, laid out with the Pager. Every string comes from the i18n
// catalogue; data text is escaped and has no em or en dashes.
import {
  noDashes,
  type HouseModel,
  type ReportBranding,
  type ReportRow,
} from '@aio/project/export';
import type { NarrativeSectionId, ReportSectionId } from '@aio/schema';
import { t } from '@aio/ui';
import { listOf, longDate, num, num1 } from '../../report/narrativeTemplate';
import { barChart, esc, logoUrl } from '../layout';
import { isFlat, pileMap, planMap, sideView } from './charts';
import type { Pager } from './pager';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Text for the report: escaped, no em or en dashes. */
export const txt = (s: string): string => esc(noDashes(s));

/** Narrative text: escaped, [bracketed] prompts the author still has to replace marked. */
export const narrativeHtml = (s: string): string =>
  txt(s).replace(/\[([^\]\n]{1,300})\]/g, '<mark>[$1]</mark>');

export function el(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const first = tpl.content.firstElementChild;
  if (!(first instanceof HTMLElement)) throw new Error('Report block is not an element');
  return first;
}

export interface HouseImages {
  /** Project picture (`thumbnail.jpg`). */
  thumbnail?: string;
  /** Overview renders of the 3D model. */
  overview: string[];
}

export interface HouseContext {
  h: HouseModel;
  text: Record<NarrativeSectionId, string>;
  images: HouseImages;
  product: string;
}

export const kickerOf = (h: HouseModel): string => tk(`house.kicker.${h.kind}`);
export const disclaimerOf = (h: HouseModel): string => tk(`house.disclaimer.${h.kind}`);

export const chip = (color: string, label: string): string =>
  `<span class="sev" style="--c:${esc(color)}"><i></i>${txt(label)}</span>`;

const statusLabel = (s: string) => tk(`house.status.${s}`);

/** Chart widths in CSS pixels: the full page body (182 mm) and half of it. */
const FULL = 688;
const HALF = 333;

/** A height in metres: centimetres below 10 m, decimetres above. */
export const metres = (h: number): string =>
  `${Math.abs(h) < 10 ? (Math.round(h * 100) / 100).toString() : num1(h)} m`;

/* ----------------------------------------------------------------------------------- frames */

/** The small brand mark in a page header: logo, else company name, else nothing. */
function headerBrand(b: ReportBranding): string {
  if (b.logo) return `<img class="pg-logo" src="${esc(logoUrl(b.logo))}" alt="">`;
  if (b.name) return `<span class="pg-co">${txt(b.name)}</span>`;
  return '';
}

/** Header and footer of a content page; the page number is filled in once laid out. */
export function frameHtml(ctx: HouseContext): string {
  const b = ctx.h.base.branding;
  const left = b.name ? txt(b.name) : b.credit ? txt(b.credit) : '';
  return `<header class="pg-h">${headerBrand(b)}<span class="pg-t">${txt(kickerOf(ctx.h))} · ${txt(ctx.h.base.title)}</span><span class="pg-s">${txt(tk('house.state', { date: ctx.h.base.date }))}</span></header><div class="pg-b"></div><footer class="pg-f"><span class="pg-fl">${left}</span><span class="pg-fc">${txt(disclaimerOf(ctx.h))}</span><span class="pg-n"></span></footer>`;
}

/* ------------------------------------------------------------------------------------ cover */

export function coverHtml(ctx: HouseContext): string {
  const { h } = ctx;
  const b = h.base.branding;
  const first = h.captures[0];
  const last = h.captures.at(-1);
  const captured =
    first && last
      ? first.date === last.date
        ? longDate(first.date)
        : `${longDate(first.date)} ${tk('house.and')} ${longDate(last.date)}`
      : '';
  const counts = [
    h.base.total > 0 || h.kind === 'inspection'
      ? tk('house.n.issues', { count: h.base.total, n: num(h.base.total) })
      : '',
    h.totals.photos > 0
      ? tk('house.n.photos', { count: h.totals.photos, n: num(h.totals.photos) })
      : '',
  ].filter(Boolean);
  const mark = b.logo
    ? `<div class="cv-mark"><span class="cv-logo"><img src="${esc(logoUrl(b.logo))}" alt=""></span></div>`
    : b.name
      ? `<div class="cv-mark"><span class="cv-name">${txt(b.name)}</span></div>`
      : '';
  const bg = ctx.images.thumbnail
    ? `<img class="cv-bg" src="${esc(ctx.images.thumbnail)}" alt="">`
    : '';
  const who = [h.base.customer, h.base.site].filter(Boolean).map(txt).join(' · ');
  const bottom = b.name
    ? txt(tk('house.cover.preparedBy', { name: b.name }))
    : txt(tk('house.cover.made', { product: ctx.product }));
  return `${bg}<div class="cv-shade"></div><div class="cv-in${mark ? '' : ' solo'}">${mark}<div class="cv-text">
  <div class="cv-kicker">${txt(tk('house.cover.status'))}</div>
  <h1>${txt(h.base.title)}</h1>
  <div class="cv-sub">${txt(kickerOf(h))}</div>
  ${who ? `<div class="cv-line">${who}</div>` : ''}
  <div class="cv-line">${[captured ? txt(tk('house.cover.captured', { date: captured })) : '', txt(tk('house.cover.issued', { date: longDate(h.base.date) }))].filter(Boolean).join(' · ')}</div>
  ${counts.length ? `<div class="cv-line">${txt(counts.join(' · '))}</div>` : ''}
</div></div><div class="cv-foot">${bottom}</div>`;
}

export function backHtml(ctx: HouseContext): string {
  const b = ctx.h.base.branding;
  const year = ctx.h.base.date.slice(0, 4);
  const text = b.name
    ? tk('house.back.rights', { year, name: b.name })
    : tk('house.back.neutral', { product: ctx.product });
  const mark = b.logo
    ? `<span class="cv-logo"><img src="${esc(logoUrl(b.logo))}" alt=""></span>`
    : '';
  return `<div class="bk-in">${mark}<p>${txt(text)}</p></div>`;
}

/* --------------------------------------------------------------------------------- contents */

export interface ContentsEntry {
  label: string;
  page: number;
  /** Appendix letter or section number. */
  num: string;
  sub?: boolean;
}

export function contentsHtml(entries: readonly ContentsEntry[], kicker: string): string {
  const rows = entries
    .map(
      (e) =>
        `<li class="${e.sub ? 'sub' : ''}"><span class="ct-n">${esc(e.num)}</span><span class="ct-l">${txt(e.label)}</span><span class="ct-d"></span><span class="ct-p">${String(e.page)}</span></li>`,
    )
    .join('');
  return `<div class="kicker">${txt(kicker)}</div><h1>${txt(tk('house.contents'))}</h1><ol class="contents">${rows}</ol>`;
}

/* ---------------------------------------------------------------------------- flow helpers */

export function heading(p: Pager, kicker: string, title: string): void {
  p.add(el(`<div class="kicker">${txt(kicker)}</div>`), true);
  p.add(el(`<h1>${txt(title)}</h1>`), true);
}

function subheading(p: Pager, title: string): void {
  p.add(el(`<h2>${txt(title)}</h2>`), true);
}

function paragraphs(p: Pager, text: string): void {
  for (const para of text.split(/\n\s*\n/)) {
    const s = para.trim();
    if (s) p.add(el(`<p class="nar">${narrativeHtml(s)}</p>`));
  }
}

function tableMaker(cls: string, head: readonly string[]) {
  return () => {
    const table = el(
      `<table class="${cls}"><thead><tr>${head.map((x) => `<th>${txt(x)}</th>`).join('')}</tr></thead><tbody></tbody></table>`,
    );
    const tbody = table.querySelector('tbody');
    if (!tbody) throw new Error('tbody');
    return { table, tbody: tbody as HTMLElement };
  };
}

const row = (cells: readonly string[], cls = '') =>
  el(
    `<table><tbody><tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr></tbody></table>`,
  ).querySelector('tr') as HTMLElement;

function tiles(items: readonly { value: string; label: string; color?: string }[]): HTMLElement {
  return el(
    `<div class="tiles">${items
      .map(
        (x) =>
          `<div class="tile"${x.color ? ` style="--c:${esc(x.color)}"` : ''}><b>${esc(x.value)}</b><span>${txt(x.label)}</span></div>`,
      )
      .join('')}</div>`,
  );
}

/* ---------------------------------------------------------------------------------- summary */

export function layoutSummary(p: Pager, ctx: HouseContext, n: string): void {
  const { h } = ctx;
  heading(p, `${n} · ${kickerOf(h)}`, tk('house.sec.summary'));
  paragraphs(p, ctx.text.summary);
  const items: { value: string; label: string; color?: string }[] = [];
  if (h.base.total > 0 || h.kind === 'inspection')
    items.push({ value: num(h.base.total), label: tk('house.kpi.issues') });
  // graded levels; uncertain items get their own tile below
  const graded = h.uncertain.length > 0 ? h.base.bySeverity.slice(0, -1) : h.base.bySeverity;
  for (const s of graded)
    if (s.count > 0) items.push({ value: num(s.count), label: s.label, color: s.color });
  if (h.uncertain.length > 0)
    items.push({ value: num(h.uncertain.length), label: tk('house.kpi.uncertain') });
  if (h.volumes) {
    const last = h.volumes.totals.at(-1) ?? 0;
    items.push({ value: num(last), label: tk('house.kpi.volume') });
    items.push({ value: num(h.volumes.pileChange.net), label: tk('house.kpi.change') });
  }
  if (h.road) {
    if (h.road.networkPci !== null)
      items.push({ value: num1(h.road.networkPci), label: tk('house.kpi.pci') });
    items.push({ value: num1(h.road.lengthKm), label: tk('house.kpi.length') });
  }
  if (h.totals.photos > 0)
    items.push({ value: num(h.totals.photos), label: tk('house.kpi.photos') });
  items.push({ value: num(h.captures.length), label: tk('house.kpi.surveys') });
  p.add(tiles(items.slice(0, 6)));
  const worst = h.base.rows.filter((r) => r.severity !== 'uncertain').slice(0, 8);
  if (worst.length > 0) {
    subheading(p, tk('house.worst'));
    p.table(
      tableMaker('grid worst', [
        tk('house.col.code'),
        tk('house.col.severity'),
        tk('house.col.title'),
        tk('house.col.zone'),
      ]),
      worst.map((r) =>
        row([
          `<b>${esc(r.code)}</b>`,
          chip(r.severityColor, r.severityLabel),
          txt(r.title),
          txt(r.zone),
        ]),
      ),
    );
  } else if (h.kind === 'inspection') {
    p.add(el(`<p class="empty">${txt(tk('house.noIssues'))}</p>`));
  }
  const v = h.volumes;
  if (v && v.piles.length > 0) {
    const last = v.captures.length - 1;
    const largest = [...v.piles]
      .filter((x) => x.net[last] !== null && x.net[last] !== undefined)
      .sort((a, b) => (b.net[last] ?? 0) - (a.net[last] ?? 0))
      .slice(0, 8);
    subheading(p, tk('house.volumes.largest'));
    p.table(
      tableMaker('grid num', [
        tk('house.col.pile'),
        `${longDate(v.captures[last]?.date ?? '')}, m³`,
        tk('house.col.changeM3'),
      ]),
      largest.map((x) =>
        row([`<b>${txt(x.name)}</b>`, num(x.net[last] ?? 0), num(x.change)], 'num'),
      ),
    );
  }
}

/* ------------------------------------------------------------------------------------ scope */

export function layoutScope(p: Pager, ctx: HouseContext, n: string): void {
  const { h } = ctx;
  heading(p, `${n} · ${kickerOf(h)}`, tk('house.sec.scope'));
  paragraphs(p, ctx.text.method);
  p.add(
    el(`<div class="limits">
  <div><b>01</b><h3>${txt(tk('house.limit.visual'))}</h3><p>${txt(tk(`house.limit.visual.${h.kind}`))}</p></div>
  <div><b>02</b><h3>${txt(tk('house.limit.draft'))}</h3><p>${txt(tk('house.limit.draftText'))}</p></div>
  <div><b>03</b><h3>${txt(tk('house.limit.positions'))}</h3><p>${txt(tk('house.limit.positionsText'))}</p></div>
</div>`),
  );
  for (const s of h.scale) {
    subheading(p, h.scale.length > 1 ? `${tk('house.scale')} · ${s.model}` : tk('house.scale'));
    const rows = s.levels.map((l) =>
      row([chip(l.color, `${String(l.value)} · ${l.label}`), txt(l.criteria), txt(l.action)]),
    );
    if (s.uncertain) rows.push(row([chip(s.uncertain.color, s.uncertain.label), '', '']));
    p.table(
      tableMaker('grid scale', [
        tk('house.col.level'),
        tk('house.col.criteria'),
        tk('house.col.action'),
      ]),
      rows,
    );
  }
}

/* ------------------------------------------------------------------------------------- site */

export function layerKindLabel(kind: string, role: string | null): string {
  return role ? tk(`house.role.${role}`) : tk(`house.layer.${kind}`);
}

export function layerAmount(r: { kind: string; count: number | null }): string {
  if (r.count === null) return '';
  if (r.kind === 'pointcloud') return tk('house.n.points', { n: num(r.count) });
  if (r.kind === 'photos') return tk('house.n.photos', { count: r.count, n: num(r.count) });
  if (r.kind === 'panoramas') return tk('house.n.panoramas', { count: r.count, n: num(r.count) });
  return num(r.count);
}

/** Severity colours ranked worst last, so the worst dots are drawn on top. */
function colourRank(h: HouseModel): Map<string, number> {
  const rank = new Map<string, number>();
  [...h.base.bySeverity].reverse().forEach((s, i) => rank.set(s.color, i));
  return rank;
}

export function layoutSite(p: Pager, ctx: HouseContext, n: string): void {
  const { h } = ctx;
  heading(p, `${n} · ${kickerOf(h)}`, tk('house.sec.site'));
  const data = h.totals;
  const items = [
    { value: num(h.captures.length), label: tk('house.kpi.surveys') },
    { value: num(h.layers.length), label: tk('house.kpi.layers') },
  ];
  if (data.photos > 0) items.push({ value: num(data.photos), label: tk('house.layer.photos') });
  if (data.points > 0)
    items.push({ value: num1(data.points / 1e6), label: tk('house.kpi.points') });
  if (data.videos > 0) items.push({ value: num(data.videos), label: tk('house.layer.video') });
  p.add(tiles(items));
  subheading(p, tk('house.captures'));
  p.table(
    tableMaker('grid', [tk('house.col.date'), tk('house.col.survey')]),
    h.captures.map((c) => row([esc(longDate(c.date)), txt(c.label)])),
  );
  const figs: string[] = [];
  if (ctx.images.thumbnail)
    figs.push(
      `<figure><img src="${esc(ctx.images.thumbnail)}" alt=""><figcaption>${txt(tk('house.picture'))}</figcaption></figure>`,
    );
  ctx.images.overview.forEach((src, i) => {
    const caption = tk(i === 0 ? 'house.overview.sw' : 'house.overview.ne');
    figs.push(
      `<figure><img src="${esc(src)}" alt=""><figcaption>${txt(caption)}</figcaption></figure>`,
    );
  });
  if (figs.length > 0) {
    subheading(p, ctx.images.overview.length > 0 ? tk('house.overview') : tk('house.picture'));
    p.add(
      el(
        `<div class="figs n${String(Math.min(figs.length, 3))}">${figs.slice(0, 3).join('')}</div>`,
      ),
    );
  }
  const piles = h.volumes ? pileMap(h.volumes.piles, tk('house.pileMap')) : '';
  if (piles) {
    subheading(p, tk('house.pileMap'));
    p.add(el(`<figure class="chartfig">${piles}</figure>`));
    p.add(el(`<p class="caption">${txt(tk('house.pileMap.caption'))}</p>`));
  }
  // a stockpile survey without issues: the pile map stands in for the findings map
  if (!piles || h.plan.length > 0) {
    subheading(p, tk('house.coverage'));
    if (h.plan.length > 0) {
      const rank = colourRank(h);
      const plan = (w: number, ht: number) =>
        `<figure>${planMap(h.plan, rank, tk('house.coverage.plan'), { width: w, height: ht })}<figcaption>${txt(tk('house.coverage.plan'))}</figcaption></figure>`;
      p.add(
        el(
          isFlat(h.plan)
            ? `<div class="maps one">${plan(FULL, 330)}</div>`
            : `<div class="maps">${plan(340, 260)}<figure>${sideView(h.plan, rank, tk('house.coverage.side'))}<figcaption>${txt(tk('house.coverage.side'))}</figcaption></figure></div>`,
        ),
      );
      p.add(el(`<p class="caption">${txt(tk('house.coverage.caption'))}</p>`));
    } else {
      p.add(el(`<p class="empty">${txt(tk('house.coverage.none'))}</p>`));
    }
  }
  subheading(p, tk('house.data'));
  kindTable(p, h);
}

/** The project data by kind: layers and amounts (the full list is in an appendix). */
function kindTable(p: Pager, h: HouseModel): void {
  const groups = new Map<string, { label: string; layers: number; count: number; kind: string }>();
  for (const l of h.layers) {
    const label = layerKindLabel(l.kind, l.role);
    const g = groups.get(label) ?? { label, layers: 0, count: 0, kind: l.kind };
    g.layers++;
    g.count += l.count ?? 0;
    groups.set(label, g);
  }
  p.table(
    tableMaker('grid kinds', [
      tk('house.col.kind'),
      tk('house.col.layers'),
      tk('house.col.amount'),
    ]),
    [...groups.values()].map((g) =>
      row([
        txt(g.label),
        num(g.layers),
        esc(g.count > 0 ? layerAmount({ kind: g.kind, count: g.count }) : ''),
      ]),
    ),
  );
}

function layerTable(p: Pager, h: HouseModel): void {
  p.table(
    tableMaker('grid layers', [
      tk('house.col.kind'),
      tk('house.col.layer'),
      tk('house.col.amount'),
    ]),
    h.layers.map((l) =>
      row([txt(layerKindLabel(l.kind, l.role)), txt(l.name), esc(layerAmount(l))]),
    ),
  );
}

/* ------------------------------------------------------------------------------- statistics */

export function layoutStatistics(p: Pager, ctx: HouseContext, n: string): void {
  const { h } = ctx;
  const b = h.base;
  heading(p, `${n} · ${kickerOf(h)}`, tk('house.sec.statistics'));
  if (ctx.text.findings) {
    subheading(p, tk('house.findings'));
    paragraphs(p, ctx.text.findings);
  }
  if (b.total > 0) {
    p.add(
      el(
        `<div class="tiles">${b.byStatus
          .map(
            (s) =>
              `<div class="tile"><b>${num(s.count)}</b><span>${txt(statusLabel(s.status))}</span></div>`,
          )
          .join('')}</div>`,
      ),
    );
    p.add(
      el(
        `<figure class="chartfig"><figcaption>${txt(tk('house.bySeverity'))}</figcaption>${barChart(b.bySeverity, FULL)}</figure>`,
      ),
    );
    const zones = b.byZone
      .slice(0, 14)
      .map((z) => ({ label: z.zone, color: 'var(--acc)', count: z.count }));
    const more =
      b.byZone.length > 14
        ? `<p class="caption">${txt(tk('house.moreZones', { n: num(b.byZone.length - 14) }))}</p>`
        : '';
    p.add(
      el(
        `<div class="charts2"><figure class="chartfig"><figcaption>${txt(tk('house.byClass'))}</figcaption>${barChart(b.byClass.slice(0, 14), HALF)}</figure><figure class="chartfig"><figcaption>${txt(tk('house.byZone'))}</figcaption>${barChart(zones, HALF)}${more}</figure></div>`,
      ),
    );
  } else if (!h.volumes && !h.road) {
    p.add(el(`<p class="empty">${txt(tk('house.noIssues'))}</p>`));
  }
  if (h.volumes) layoutVolumes(p, h);
  if (h.road) layoutRoad(p, h);
}

function layoutVolumes(p: Pager, h: HouseModel): void {
  const v = h.volumes;
  if (!v) return;
  subheading(p, tk('house.volumes'));
  p.add(
    el(
      `<p class="caption">${txt(tk('house.volumes.intro', { base: v.baseLabel.toLowerCase(), density: num1(v.densityTPerM3) }))}</p>`,
    ),
  );
  p.add(
    el(
      `<figure class="chartfig">${barChart(
        v.captures.map((c, i) => ({
          label: longDate(c.date),
          color: 'var(--acc)',
          count: Math.round(v.totals[i] ?? 0),
        })),
        FULL,
      )}</figure>`,
    ),
  );
  const head = [
    tk('house.col.pile'),
    tk('house.col.material'),
    ...v.captures.map((c) => longDate(c.date)),
    tk('house.col.area'),
    tk('house.col.height'),
    tk('house.col.changeM3'),
  ];
  const rows = v.piles.map((pile) =>
    row(
      [
        `<b>${txt(pile.name)}</b>${pile.edited ? ' *' : ''}`,
        txt(pile.material),
        ...pile.net.map((x) => (x === null ? '' : num(x))),
        pile.areaM2 === null ? '' : num(pile.areaM2),
        pile.heightM === null ? '' : num1(pile.heightM),
        num(pile.change),
      ],
      'num',
    ),
  );
  rows.push(
    row(
      [
        `<b>${txt(tk('house.volumes.total'))}</b>`,
        '',
        ...v.totals.map((x) => `<b>${num(x)}</b>`),
        '',
        '',
        `<b>${num(v.pileChange.net)}</b>`,
      ],
      'num total',
    ),
  );
  p.table(tableMaker('grid num', head), rows);
  if (v.piles.some((x) => x.edited))
    p.add(el(`<p class="caption">* ${txt(tk('house.volumes.edited'))}</p>`));
  subheading(p, tk('house.volumes.change'));
  p.table(
    tableMaker('grid num', ['', tk('house.col.fill'), tk('house.col.cut'), tk('house.col.net')]),
    [
      row(
        [
          txt(tk('house.volumes.piles')),
          num(v.pileChange.fill),
          num(v.pileChange.cut),
          num(v.pileChange.net),
        ],
        'num',
      ),
      row(
        [
          txt(tk('house.volumes.site')),
          num(v.siteChange.fill),
          num(v.siteChange.cut),
          num(v.siteChange.net),
        ],
        'num',
      ),
    ],
  );
}

function layoutRoad(p: Pager, h: HouseModel): void {
  const r = h.road;
  if (!r) return;
  subheading(p, tk('house.pci'));
  p.add(
    el(
      `<p class="caption">${txt(
        tk('house.pci.intro', {
          standard: r.standard,
          severity: tk(`house.pci.${r.headline}`),
          units: num(r.units),
          km: num1(r.lengthKm),
          coverage: r.coveragePct === null ? '' : num1(r.coveragePct),
        }),
      )}</p>`,
    ),
  );
  p.add(
    el(
      `<figure class="chartfig"><figcaption>${txt(tk('house.pci.ratings'))}</figcaption>${barChart(
        r.ratings.map((x) => ({ label: x.label, color: x.color, count: x.count })),
        FULL,
      )}</figure>`,
    ),
  );
  subheading(p, tk('house.pci.sections'));
  p.table(
    tableMaker('grid num', [
      tk('house.col.from'),
      tk('house.col.to'),
      tk('house.col.pci'),
      tk('house.col.rating'),
    ]),
    r.sections.map((s) =>
      row(
        [
          km(s.fromKm),
          km(s.toKm),
          s.pci === null ? '' : num1(s.pci),
          s.rating ? chip(s.color, s.rating) : '',
        ],
        'num',
      ),
    ),
  );
  if (r.worst.length > 0) {
    subheading(p, tk('house.pci.worst'));
    p.table(
      tableMaker('grid', [
        tk('house.col.unit'),
        tk('house.col.km'),
        tk('house.col.pci'),
        tk('house.col.rating'),
        tk('house.col.distress'),
      ]),
      r.worst.map((w) =>
        row([esc(w.id), km(w.km), num1(w.pci), chip(w.color, w.rating), txt(w.distress)]),
      ),
    );
  }
}

/* --------------------------------------------------------------------------------- register */

/** Lays out the register; returns each row's `td.page` cell so page numbers can be filled in. */
export function layoutRegister(p: Pager, ctx: HouseContext, n: string): Map<string, HTMLElement> {
  const { h } = ctx;
  const b = h.base;
  p.add(
    el(
      `<div class="kicker">${txt(`${n} · ${tk('house.register.kicker', { n: num(b.total) })}`)}</div>`,
    ),
    true,
  );
  p.add(el(`<h1>${txt(tk('house.sec.register'))}</h1>`), true);
  if (b.total === 0) {
    p.add(el(`<p class="empty">${txt(tk('house.noIssues'))}</p>`));
    return new Map();
  }
  p.add(el(`<p class="caption">${txt(tk('house.register.intro'))}</p>`), true);
  const cells = new Map<string, HTMLElement>();
  const rows = b.rows.map((r) => {
    const tr = row(
      [
        `<b>${esc(r.code)}</b>`,
        chip(r.severityColor, r.severityLabel),
        txt(r.classLabel),
        txt(r.title),
        txt(r.zone),
        num(r.sightings),
        txt(tk('house.col.listed')),
      ],
      'reg',
    );
    const last = tr.lastElementChild;
    if (last instanceof HTMLElement) {
      last.className = 'page';
      cells.set(r.id, last);
    }
    return tr;
  });
  p.table(
    tableMaker('grid register', [
      tk('house.col.code'),
      tk('house.col.severity'),
      tk('house.col.class'),
      tk('house.col.title'),
      tk('house.col.zone'),
      tk('house.col.photos'),
      tk('house.col.page'),
    ]),
    rows,
  );
  return cells;
}

/* ------------------------------------------------------------------------------- issue page */

/** Chainage in km with metres: 0.25, 7.45. */
const km = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

export interface IssueImages {
  /** Where an issue placed on the map only lies, among its neighbours (SVG). */
  locator?: string;
  /** Source photo with the marked area and the close-up frame. */
  photo?: string;
  /** Close-up of the marked area. */
  closeup?: string;
  /** 3D view at the issue. */
  view?: string;
}

export interface IssueExtra {
  photoName: string;
  captured: string;
  action: string;
  /** `action` is the grade's meaning, the level has no action. */
  actionIsCriteria: boolean;
  disclaimer: string;
}

export function issuePageHtml(r: ReportRow, img: IssueImages, extra: IssueExtra): string {
  const seen = tk('house.n.seen', { count: r.sightings, n: num(r.sightings) });
  const kicker = tk('house.issue.kicker', { code: r.code, seen, zone: r.zone });
  const height = r.position ? metres(r.position[1]) : '';
  const meta: [string, string][] = [
    [tk('house.issue.severity'), r.severityLabel],
    [tk('house.issue.class'), r.classLabel],
    [tk('house.issue.status'), statusLabel(r.status)],
    [tk('house.issue.zone'), r.zone],
    [tk('house.issue.position'), r.coords || tk('house.issue.notPlaced')],
    ...(r.wgs84 ? ([[tk('house.issue.wgs84'), r.wgs84]] as [string, string][]) : []),
    ...(extra.photoName
      ? ([[tk('house.issue.photo'), extra.photoName]] as [string, string][])
      : []),
    ...(extra.captured
      ? ([[tk('house.issue.captured'), extra.captured]] as [string, string][])
      : []),
    [tk('house.issue.author'), `${r.author}${r.updatedAt ? `, ${r.updatedAt}` : ''}`],
  ];
  const view = img.view
    ? `<img src="${esc(img.view)}" alt=""><figcaption>${txt(tk('house.issue.view'))}</figcaption>`
    : img.locator
      ? `<div class="ip-loc">${img.locator}</div><figcaption>${txt(tk('house.issue.locator'))}</figcaption>`
      : `<div class="noimg">${txt(r.position ? tk('house.issue.noView') : tk('house.issue.noPosition'))}</div>`;
  const photo = img.photo
    ? `<div class="ip-photo"><img src="${esc(img.photo)}" alt=""></div><p class="caption">${txt(tk('house.issue.source'))}</p>`
    : `<div class="ip-photo"><div class="noimg">${txt(tk('house.issue.noPhoto'))}</div></div>`;
  const note = r.note.trim();
  return `<div class="ip-head"><div class="ip-tl"><div class="kicker">${txt(kicker)}</div><h2>${txt(r.title)}</h2></div><div class="ip-sev"><span class="lbl">${txt(tk('house.issue.severity'))}</span>${chip(r.severityColor, r.severityLabel)}</div>${height ? `<div class="ip-ht"><span class="lbl">${txt(tk('house.issue.height'))}</span><b>${esc(height)}</b></div>` : ''}</div>
<div class="ip-top"><figure class="ip-view">${view}</figure><dl class="ip-meta">${meta.map(([k, v]) => `<dt>${txt(k)}</dt><dd>${txt(v)}</dd>`).join('')}</dl></div>
${photo}
<div class="ip-bottom${img.closeup ? '' : ' wide'}">${img.closeup ? `<figure class="ip-close"><img src="${esc(img.closeup)}" alt=""><figcaption>${txt(tk('house.issue.closeup'))}</figcaption></figure>` : ''}<div class="ip-note"><h3>${txt(tk('house.issue.note'))}</h3><p class="note${extra.action ? '' : ' long'}">${note ? txt(note) : `<span class="faint">${txt(tk('house.issue.noNote'))}</span>`}</p>${extra.action ? `<h3>${txt(tk(extra.actionIsCriteria ? 'house.issue.criteria' : 'house.issue.action'))}</h3><p class="action">${txt(extra.action)}</p>` : ''}<p class="faint small">${txt(extra.disclaimer)}</p></div></div>`;
}

/* ------------------------------------------------------------------------------- appendices */

export function layoutAppendices(
  p: Pager,
  ctx: HouseContext,
  start: (title: string, letter: string) => void,
): void {
  const { h } = ctx;
  const letters = 'ABCDEFG';
  let i = 0;
  const next = (title: string) => {
    const letter = letters[i++] ?? '';
    start(title, letter);
    p.add(el(`<div class="kicker">${txt(tk('house.appendix', { letter }))}</div>`), true);
    p.add(el(`<h1>${txt(title)}</h1>`), true);
  };
  if (h.uncertain.length > 0) {
    next(tk('house.app.uncertain'));
    p.add(
      el(
        `<p class="caption">${txt(tk('house.app.uncertain.intro', { n: num(h.uncertain.length) }))}</p>`,
      ),
      true,
    );
    p.table(
      tableMaker('grid uncertain', [
        tk('house.col.code'),
        tk('house.col.title'),
        tk('house.col.zone'),
        tk('house.col.note'),
      ]),
      h.uncertain.map((r) =>
        row([`<b>${esc(r.code)}</b>`, txt(r.title), txt(r.zone), txt(firstLine(r.note))]),
      ),
    );
  }
  next(tk('house.app.data'));
  p.add(el(`<p class="caption">${txt(tk('house.app.data.intro'))}</p>`), true);
  layerTable(p, h);
  next(tk('house.app.conventions'));
  for (const s of [
    tk('house.conv.crs', { crs: h.base.crs }),
    tk('house.conv.positions'),
    tk('house.conv.codes'),
    h.base.branding.name
      ? tk('house.conv.generatedFor', { date: longDate(h.base.date) })
      : tk('house.conv.generated', { date: longDate(h.base.date), product: ctx.product }),
  ])
    p.add(el(`<p class="nar">${txt(s)}</p>`));
}

const firstLine = (s: string) => s.split('\n')[0] ?? '';

/** Section titles for the contents. */
export const sectionTitle = (id: ReportSectionId): string => tk(`house.sec.${id}`);

export { listOf };
