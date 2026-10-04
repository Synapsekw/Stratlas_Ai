// Issue register report layout: pure HTML building blocks, printed to PDF by main.
import { noDashes, type CountRow, type ReportModel, type ReportRow } from '@aio/project/export';
import type { Vec3 } from '@aio/schema';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Text for the report: escaped, no em or en dashes, line breaks kept. */
const txt = (s: string) => esc(noDashes(s)).replace(/\n/g, '<br>');

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crop of a photo around a marked box [x, y, w, h]: twice the box with context, at least 30 %
 * of the photo width, at `aspect`, kept inside the image. The whole photo without a box.
 */
export function cropRect(
  box: readonly [number, number, number, number] | null,
  imgW: number,
  imgH: number,
  aspect = 4 / 3,
): Rect {
  if (!box) return { x: 0, y: 0, w: imgW, h: imgH };
  const [bx, by, bw, bh] = box;
  let w = Math.max(bw * 2, bh * 2 * aspect, imgW * 0.3);
  let h = w / aspect;
  if (h > imgH) {
    h = imgH;
    w = h * aspect;
  }
  if (w > imgW) {
    w = imgW;
    h = w / aspect;
  }
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const x = Math.min(Math.max(0, cx - w / 2), imgW - w);
  const y = Math.min(Math.max(0, cy - h / 2), imgH - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Camera for an issue's 3D snapshot: in front of the surface along its normal, or from outside
 * the model (away from its vertical axis, a little above), at a distance scaled to the model.
 */
export function snapshotPose(
  p: Vec3,
  normal: Vec3 | null,
  center: Vec3,
  radius: number,
): { eye: Vec3; target: Vec3 } {
  const dist = Math.min(25, Math.max(3, radius * 0.25));
  let dir: Vec3;
  if (normal && Math.hypot(...normal) > 1e-6) dir = norm(normal);
  else {
    const h: Vec3 = [p[0] - center[0], 0, p[2] - center[2]];
    const flat: Vec3 = Math.hypot(h[0], h[2]) < 1e-6 ? [0, 0, 1] : norm(h);
    dir = norm([flat[0], 0.35, flat[2]]);
  }
  return { eye: [p[0] + dir[0] * dist, p[1] + dir[1] * dist, p[2] + dir[2] * dist], target: p };
}

/**
 * Camera outside a hollow asset (a finding on the inside of a tank): out from the vertical axis
 * through the finding, above it, aimed between the finding and the centre so the whole asset
 * shows (drawn see-through).
 */
export function exteriorPose(p: Vec3, center: Vec3, radius: number): { eye: Vec3; target: Vec3 } {
  const h: Vec3 = [p[0] - center[0], 0, p[2] - center[2]];
  const flat: Vec3 = Math.hypot(h[0], h[2]) < 1e-6 ? [0, 0, 1] : norm(h);
  const dir = norm([flat[0], 0.7, flat[2]]);
  const dist = radius * 2.3;
  const k = 0.6;
  return {
    eye: [center[0] + dir[0] * dist, center[1] + dir[1] * dist, center[2] + dir[2] * dist],
    target: [
      p[0] + (center[0] - p[0]) * k,
      p[1] + (center[1] - p[1]) * k,
      p[2] + (center[2] - p[2]) * k,
    ],
  };
}

/** Horizontal bar chart as inline SVG. */
export function barChart(rows: readonly CountRow[], width = 520): string {
  const rowH = 22;
  const labelW = Math.round(width * 0.4);
  const countW = 44;
  const barW = width - labelW - countW;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const h = rows.length * rowH + 4;
  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 4;
      const w = (r.count / max) * barW;
      return `<text x="0" y="${String(y + 11)}" class="cl">${txt(r.label)}</text><rect x="${String(labelW)}" y="${String(y + 2)}" width="${w.toFixed(1)}" height="12" rx="2" fill="${esc(r.color)}"/><text x="${String(width)}" y="${String(y + 11)}" class="cn" text-anchor="end">${String(r.count)}</text>`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${String(width)} ${String(h)}" width="100%" role="img">${bars}</svg>`;
}

export interface IssueImages {
  photo?: string;
  view?: string;
}

const chip = (color: string, label: string) =>
  `<span class="chip"><i style="background:${esc(color)}"></i>${txt(label)}</span>`;

function cover(m: ReportModel): string {
  const worst = m.bySeverity
    .filter((s) => s.count > 0)
    .map((s) => `${chip(s.color, s.label)}<b>${String(s.count)}</b>`)
    .join('');
  return `<section class="cover">
  <div class="brand">${txt(m.brandName)}</div>
  <div class="cover-main">
    <div class="kicker">Issue register</div>
    <h1>${txt(m.title)}</h1>
    <div class="who">${[m.customer, m.site].filter(Boolean).map(txt).join('<br>')}</div>
    <div class="tally"><span class="big">${String(m.total)}</span> issues</div>
    <div class="sevrow">${worst}</div>
  </div>
  <dl class="cover-meta">
    <dt>Report date</dt><dd>${esc(m.date)}</dd>
    ${m.captureLabel ? `<dt>Capture</dt><dd>${txt(m.captureLabel)}</dd>` : ''}
    <dt>Coordinates</dt><dd>${esc(m.crs)}</dd>
  </dl>
</section>`;
}

function summary(m: ReportModel): string {
  const statuses = m.byStatus
    .map((s) => `<div class="tile"><b>${String(s.count)}</b><span>${esc(s.status)}</span></div>`)
    .join('');
  const zones = m.byZone
    .slice(0, 16)
    .map((z) => ({ label: z.zone, color: '#3fb8a0', count: z.count }));
  const more =
    m.byZone.length > 16
      ? `<p class="small">${String(m.byZone.length - 16)} more zones in the register.</p>`
      : '';
  return `<section class="summary">
  <h2>Summary</h2>
  <div class="tiles"><div class="tile total"><b>${String(m.total)}</b><span>issues</span></div>${statuses}</div>
  <div class="charts">
    <figure><figcaption>By severity</figcaption>${barChart(m.bySeverity)}</figure>
  </div>
  <div class="charts two">
    <figure><figcaption>By class</figcaption>${barChart(m.byClass.slice(0, 16), 380)}</figure>
    <figure><figcaption>By zone</figcaption>${barChart(zones, 380)}${more}</figure>
  </div>
</section>`;
}

function register(m: ReportModel): string {
  const rows = m.rows
    .map(
      (r) =>
        `<tr><td class="code">${esc(r.code)}</td><td>${txt(r.title)}</td><td>${txt(r.classLabel)}</td><td>${chip(r.severityColor, r.severityLabel)}</td><td>${esc(r.status)}</td><td>${txt(r.zone)}</td></tr>`,
    )
    .join('');
  return `<section class="register">
  <h2>Issue register</h2>
  <table><thead><tr><th>Code</th><th>Title</th><th>Class</th><th>Severity</th><th>Status</th><th>Zone</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}

function issuePage(r: ReportRow, img: IssueImages | undefined): string {
  const fig = (src: string | undefined, caption: string, empty: string) =>
    `<figure>${src ? `<img src="${esc(src)}" alt="">` : `<div class="noimg">${esc(empty)}</div>`}<figcaption>${esc(caption)}</figcaption></figure>`;
  const meta: [string, string][] = [
    ['Class', r.classLabel],
    ['Status', r.status],
    ['Zone', r.zone],
    ['Position', r.coords || 'Not placed'],
    ...(r.wgs84 ? ([['WGS84', r.wgs84]] as [string, string][]) : []),
    ['Sightings', String(r.sightings)],
    ['Author', r.author],
    ['Updated', r.updatedAt],
  ];
  return `<section class="issue-page">
  <header class="ih"><span class="code">${esc(r.code)}</span><h3>${txt(r.title)}</h3>${chip(r.severityColor, r.severityLabel)}</header>
  <div class="figs">
    ${fig(img?.photo, r.photo ? `Photo ${r.photo.photo}` : 'Photo', 'No photo')}
    ${fig(img?.view, '3D view', r.position ? '3D view not available' : 'No 3D position')}
  </div>
  <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${txt(v)}</dd>`).join('')}</dl>
  ${r.note ? `<div class="note">${txt(r.note)}</div>` : ''}
</section>`;
}

/** The whole report body. */
export function reportHtml(m: ReportModel, images: ReadonlyMap<string, IssueImages>): string {
  return [
    cover(m),
    summary(m),
    register(m),
    ...m.rows.map((r) => issuePage(r, images.get(r.id))),
  ].join('\n');
}
