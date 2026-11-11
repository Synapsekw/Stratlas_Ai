/**
 * Facts and links from a project's sources. Pure and deterministic: the same sources give the same
 * facts and links, in the same order, so a rebuilt index equals the one it replaces.
 */
import type {
  AuditEntry,
  ChangeItem,
  Fact,
  FactKind,
  FactLink,
  FactRelation,
  Issue,
  ProjectManifest,
  SurveyMeasurement,
} from '@aio/schema';
import type { ProjectSources } from './sources';

export interface Extracted {
  /** Sorted by id, ids unique. */
  facts: Fact[];
  /** Sorted, unique. */
  links: FactLink[];
}

type Vec3 = readonly [number, number, number];
interface EN {
  e: number;
  n: number;
}

/** The subject a journal op's target names (see `Fact.subject`). */
export function subjectOfTarget(t: { rec: string; id: string; in?: string | undefined }): string {
  return t.rec === 'change-item' && t.in ? `change-item:${t.in}/${t.id}` : `${t.rec}:${t.id}`;
}

const words = (...parts: (string | number | undefined | null | false)[]): string | undefined => {
  const t = parts
    .filter((p): p is string | number => p !== undefined && p !== null && p !== false && p !== '')
    .map(String)
    .join(' ')
    .trim();
  return t ? t.slice(0, 4000) : undefined;
};

const centroid = (pts: readonly Vec3[]): EN | undefined => {
  if (!pts.length) return undefined;
  let e = 0;
  let n = 0;
  for (const p of pts) {
    e += p[0];
    n += p[1];
  }
  return { e: e / pts.length, n: n / pts.length };
};

/** Is (e, n) inside the ring (even-odd)? */
export function inside(e: number, n: number, ring: readonly (readonly number[])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi = 0, yi = 0] = a;
    const [xj = 0, yj = 0] = b;
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi || 1e-12) + xi) hit = !hit;
  }
  return hit;
}

class Builder {
  readonly facts = new Map<string, Fact>();
  readonly links = new Map<string, FactLink>();

  add(f: Fact): void {
    // Drop absent fields so the same input always gives the same object.
    const clean = Object.fromEntries(
      Object.entries(f).filter(
        ([, v]) => v !== undefined && !(typeof v === 'number' && !isFinite(v)),
      ),
    ) as Fact;
    if (!this.facts.has(clean.id)) this.facts.set(clean.id, clean);
  }

  link(from: string, to: string, rel: FactRelation): void {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${rel}`;
    if (!this.links.has(key)) this.links.set(key, { from, to, rel });
  }

  done(): Extracted {
    const facts = [...this.facts.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const links = [...this.links.values()].sort((a, b) =>
      a.from !== b.from
        ? a.from < b.from
          ? -1
          : 1
        : a.to !== b.to
          ? a.to < b.to
            ? -1
            : 1
          : a.rel < b.rel
            ? -1
            : a.rel > b.rel
              ? 1
              : 0,
    );
    return { facts, links };
  }
}

interface PhotoInfo {
  subject: string;
  capture?: string;
  pos?: EN;
}

/** The context every extractor shares: dates, the frame, photos and class names. */
class Context {
  readonly dates = new Map<string, { label: string; date: string }>();
  readonly layerCapture = new Map<string, string>();
  /** `<layer>/<photo>` and, for passes without a layer, `*\/<photo>` (the first layer with it). */
  readonly photos = new Map<string, PhotoInfo>();
  readonly classes = new Map<string, string>();
  private readonly origin: Vec3;

  constructor(readonly manifest: ProjectManifest | null) {
    this.origin = manifest ? manifest.origin : [0, 0, 0];
    for (const c of manifest?.captures ?? [])
      this.dates.set(c.id, { label: c.label, date: c.date });
    for (const cat of manifest?.classCatalogues ?? []) {
      for (const k of cat.classes) if (!this.classes.has(k.id)) this.classes.set(k.id, k.label);
    }
    for (const l of manifest?.layers ?? []) {
      if (l.capture) this.layerCapture.set(l.id, l.capture);
      if (l.kind !== 'photos') continue;
      for (const p of l.items) {
        const info: PhotoInfo = {
          subject: `photo:${l.id}/${p.id}`,
          ...(l.capture ? { capture: l.capture } : {}),
          ...(p.pos ? { pos: this.en(p.pos) } : {}),
        };
        this.photos.set(`${l.id}/${p.id}`, info);
        if (!this.photos.has(`*/${p.id}`)) this.photos.set(`*/${p.id}`, info);
      }
    }
  }

  /** Local frame (X east, Y up, Z south) to project easting and northing. */
  en(p: Vec3): EN {
    return { e: this.origin[0] + p[0], n: this.origin[1] - p[2] };
  }

  photo(layer: string | undefined, id: string | undefined): PhotoInfo | undefined {
    if (!id) return undefined;
    return (layer ? this.photos.get(`${layer}/${id}`) : undefined) ?? this.photos.get(`*/${id}`);
  }

  date(capture: string | undefined): string | undefined {
    return capture ? this.dates.get(capture)?.date : undefined;
  }

  dateLabel(capture: string | undefined): string | undefined {
    return capture ? this.dates.get(capture)?.label : undefined;
  }

  className(id: string): string {
    return this.classes.get(id) ?? id;
  }
}

const onDate = (ctx: Context, capture: string | undefined) =>
  capture ? { capture, ...(ctx.date(capture) ? { date: ctx.date(capture) } : {}) } : {};

const at = (e: EN | undefined) => (e ? { e: e.e, n: e.n } : {});

function manifestFacts(b: Builder, ctx: Context): void {
  const m = ctx.manifest;
  if (!m) return;
  for (const c of m.captures) {
    b.add({
      id: `survey:${c.id}`,
      kind: 'survey',
      subject: `survey:${c.id}`,
      label: c.label,
      text: words('survey date', c.date),
      capture: c.id,
      date: c.date,
      evidence: 'manifest.json',
    });
  }
  for (const l of m.layers) {
    b.add({
      id: `layer:${l.id}`,
      kind: 'layer',
      subject: `layer:${l.id}`,
      label: l.name,
      text: words(l.kind, l.derived ? 'derived' : undefined),
      ...onDate(ctx, l.capture),
      evidence: 'manifest.json',
    });
    if (l.capture) b.link(`layer:${l.id}`, `survey:${l.capture}`, 'on-survey');
    if (l.kind === 'photos') {
      for (const p of l.items) {
        const s = `photo:${l.id}/${p.id}`;
        const name = ('path' in p.src ? p.src.path.split('/').pop() : undefined) ?? p.id;
        b.add({
          id: s,
          kind: 'photo',
          subject: s,
          label: name,
          text: words('photo', l.name),
          ...onDate(ctx, l.capture),
          ...(p.takenAt ? { at: p.takenAt } : {}),
          ...at(p.pos ? ctx.en(p.pos) : undefined),
          evidence: 'manifest.json',
        });
        b.link(s, `layer:${l.id}`, 'in-layer');
        if (l.capture) b.link(s, `survey:${l.capture}`, 'on-survey');
      }
    }
    if (l.kind === 'walk') {
      b.link(`walk:${l.id}`, `layer:${l.id}`, 'in-layer');
      if (l.capture) b.link(`walk:${l.id}`, `survey:${l.capture}`, 'on-survey');
    }
  }
}

/** The outline a measurement has on a date: its own for that date, else its points. */
function ringOn(m: SurveyMeasurement, capture: string | undefined): readonly Vec3[] | null {
  if (m.family !== 'polygon') return null;
  if (m.scope.kind === 'survey' && capture && m.scope.capture !== capture) return null;
  const own = capture ? m.outlines?.find((o) => o.capture === capture) : undefined;
  const pts = own?.points ?? m.points;
  return pts.length >= 3 ? pts : null;
}

function measurementFacts(b: Builder, ctx: Context, list: readonly SurveyMeasurement[]): void {
  for (const m of list) {
    const s = `measurement:${m.id}`;
    const scopeCapture = m.scope.kind === 'survey' ? m.scope.capture : undefined;
    const fields = m.fields ? Object.values(m.fields) : [];
    b.add({
      id: s,
      kind: 'measurement',
      subject: s,
      label: m.label,
      text: words(m.tool, m.family, m.folder, m.description, ...fields),
      ...onDate(ctx, scopeCapture),
      at: m.updatedAt ?? m.createdAt,
      ...(m.createdBy ? { source: 'human' } : {}),
      ...at(centroid(m.points)),
      evidence: 'survey/measurements.json',
    });
    if (scopeCapture) b.link(s, `survey:${scopeCapture}`, 'on-survey');
    const seen = new Set<string>();
    for (const r of [...(m.series ?? []), ...m.results]) {
      const capture = r.toCapture ?? r.fromCapture;
      const key = `${capture ?? r.toLabel}/${r.item}`;
      if (seen.has(key)) continue;
      seen.add(key);
      b.add({
        id: `volume:${m.id}@${key}`,
        kind: 'volume',
        subject: s,
        label: m.label,
        text: words(
          'volume',
          r.fromLabel,
          r.toLabel,
          `cut ${r.cutM3.toFixed(1)}`,
          `fill ${r.fillM3.toFixed(1)}`,
          r.reason,
        ),
        ...onDate(ctx, capture),
        at: r.computedAt,
        value: r.netM3,
        unit: 'm3',
        status: r.status,
        evidence: 'survey/measurements.json',
      });
      if (capture) {
        b.link(s, `survey:${capture}`, 'on-survey');
        b.link(s, `qa:${capture}`, 'qa');
      }
    }
  }
}

function detectionFacts(b: Builder, ctx: Context, src: ProjectSources): void {
  for (const pass of src.detections) {
    pass.detections.forEach((d, i) => {
      const s = d.id ? `detection:${d.id}` : `detection:${pass.file}#${i}`;
      const photo = ctx.photo(pass.layer, d.photo);
      const capture = photo?.capture ?? (d.frame ? ctx.layerCapture.get(d.frame.layer) : undefined);
      const source = d.source ?? pass.source;
      const status = d.status ?? (source === 'human' ? 'accepted' : 'draft');
      const fields = (d.fields ?? []).map((f) => `${f.label} ${String(f.value ?? '')}`);
      b.add({
        id: s,
        kind: 'detection',
        subject: s,
        label: ctx.className(d.class),
        text: words(
          'detection',
          d.label,
          d.note,
          d.component,
          d.rejectReason,
          d.rejectNote,
          d.uncertain && 'uncertain',
          ...fields,
        ),
        ...onDate(ctx, capture),
        ...((d.reviewedAt ?? d.updatedAt ?? d.createdAt ?? pass.createdAt)
          ? { at: d.reviewedAt ?? d.updatedAt ?? d.createdAt ?? pass.createdAt }
          : {}),
        ...(d.confidence !== undefined ? { value: d.confidence, unit: 'score' } : {}),
        status,
        source,
        ...at(photo?.pos),
        evidence: pass.file,
      });
      if (photo) b.link(s, photo.subject, 'on-photo');
      if (capture) b.link(s, `survey:${capture}`, 'on-survey');
      if (d.issueId) b.link(s, `issue:${d.issueId}`, 'issue');
    });
  }
}

function issueCapture(ctx: Context, i: Issue): string | undefined {
  if (i.capture) return i.capture;
  for (const s of i.sightings) {
    const c = ctx.layerCapture.get(s.layer);
    if (c) return c;
  }
  return undefined;
}

function issuePlace(ctx: Context, i: Issue): EN | undefined {
  for (const s of i.sightings) {
    if (s.on === 'image') {
      const p = ctx.photo(s.layer, s.photo);
      if (p?.pos) return p.pos;
    }
    if (s.on === 'mesh' && s.geom.type === 'spoint') return ctx.en(s.geom.p);
  }
  return undefined;
}

function issueFacts(b: Builder, ctx: Context, list: readonly Issue[]): void {
  const tracks = new Map<string, Issue[]>();
  for (const i of list) {
    const s = `issue:${i.id}`;
    const capture = issueCapture(ctx, i);
    const fields = (i.fields ?? []).map((f) => `${f.label} ${String(f.value ?? '')}`);
    b.add({
      id: s,
      kind: 'issue',
      subject: s,
      label: `${i.code} ${i.title}`,
      text: words(
        'issue',
        ctx.className(i.classId),
        i.note,
        `severity ${String(i.severity)}`,
        i.resolvedIn && 'resolved',
        ...fields,
      ),
      ...onDate(ctx, capture),
      at: i.updatedAt,
      ...(typeof i.severity === 'number' ? { value: i.severity, unit: 'severity' } : {}),
      status: i.status,
      source: i.source,
      ...at(issuePlace(ctx, i)),
      evidence: 'issues.json',
    });
    if (capture) b.link(s, `survey:${capture}`, 'on-survey');
    if (i.resolvedIn) b.link(s, `survey:${i.resolvedIn}`, 'on-survey');
    for (const sg of i.sightings) {
      if (sg.on !== 'image') continue;
      const p = ctx.photo(sg.layer, sg.photo);
      if (p) b.link(s, p.subject, 'on-photo');
    }
    if (i.track) tracks.set(i.track, [...(tracks.get(i.track) ?? []), i]);
  }
  // the same defect across dates: each sighting linked to the next one of its track
  for (const group of tracks.values()) {
    const sorted = [...group].sort((a, c) => {
      const da = ctx.date(issueCapture(ctx, a)) ?? a.createdAt;
      const dc = ctx.date(issueCapture(ctx, c)) ?? c.createdAt;
      return da < dc ? -1 : da > dc ? 1 : a.id < c.id ? -1 : 1;
    });
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1];
      const c = sorted[k];
      if (a && c) b.link(`issue:${a.id}`, `issue:${c.id}`, 'issue');
    }
  }
}

function qaFacts(b: Builder, ctx: Context, src: ProjectSources): void {
  for (const { file, qa } of src.qa) {
    const s = `qa:${qa.capture}`;
    b.add({
      id: s,
      kind: 'qa',
      subject: s,
      label: `QA ${ctx.dateLabel(qa.capture) ?? qa.capture}`,
      text: words(
        'survey qa',
        qa.status,
        qa.level,
        qa.hold?.reason,
        qa.release?.note,
        qa.checkpoints && `checkpoints ${qa.checkpoints.count}`,
      ),
      ...onDate(ctx, qa.capture),
      at: qa.checkedAt,
      ...(qa.checkpoints ? { value: qa.checkpoints.rmseM, unit: 'm' } : {}),
      status: qa.status,
      source: 'pipeline',
      evidence: file,
    });
    b.link(s, `survey:${qa.capture}`, 'on-survey');
  }
  for (const { file, report } of src.accuracy) {
    const s = `accuracy:${report.run}`;
    const rmse = report.rmse.check ?? report.rmse.control;
    b.add({
      id: s,
      kind: 'accuracy',
      subject: s,
      label: `Accuracy ${report.run}`,
      text: words(
        'photo accuracy',
        report.rmse.check ? 'checkpoints' : report.rmse.control ? 'control' : undefined,
        ...report.warnings.map((w) => w.code),
      ),
      at: report.createdAt,
      ...(rmse ? { value: rmse.verticalM, unit: 'm' } : {}),
      status: report.warnings.length ? 'warning' : 'ok',
      source: 'pipeline',
      evidence: file,
    });
  }
}

function itemPlace(ctx: Context, item: ChangeItem): EN | undefined {
  if (item.at) return ctx.en(item.at);
  if (item.kind === 'region' && item.outlineLocal) {
    return centroid(
      item.outlineLocal.map((p): Vec3 => {
        const q = ctx.en(p);
        return [q.e, q.n, 0];
      }),
    );
  }
  return undefined;
}

function itemValue(item: ChangeItem): { value: number; unit: string } | Record<string, never> {
  if (item.kind === 'region' && item.volume) return { value: item.volume.netM3, unit: 'm3' };
  if (item.kind === 'region' && item.areaM2 !== undefined)
    return { value: item.areaM2, unit: 'm2' };
  if (item.kind === 'vector' && item.distanceM !== undefined)
    return { value: item.distanceM, unit: 'm' };
  if (item.kind === 'detection' && item.count?.to !== undefined)
    return { value: item.count.to, unit: 'count' };
  return {};
}

function changeFacts(b: Builder, ctx: Context, src: ProjectSources): void {
  for (const { file, set } of src.changeSets) {
    const s = `change-set:${set.id}`;
    const from = ctx.dateLabel(set.from) ?? set.from;
    const to = ctx.dateLabel(set.to) ?? set.to;
    b.add({
      id: s,
      kind: 'change-set',
      subject: s,
      label: `${from} to ${to}`,
      text: words(
        'change',
        set.producer,
        set.scope ? 'area' : undefined,
        `${set.items.length} items`,
      ),
      ...onDate(ctx, set.to),
      at: set.createdAt,
      value: set.items.length,
      unit: 'count',
      source: 'pipeline',
      evidence: file,
    });
    b.link(s, `survey:${set.from}`, 'in-set');
    b.link(s, `survey:${set.to}`, 'in-set');
    for (const item of set.items) {
      const is = `change-item:${set.id}/${item.id}`;
      const classId = 'classId' in item ? item.classId : undefined;
      b.add({
        id: is,
        kind: 'change',
        subject: is,
        label: item.label ?? `${item.kind} ${item.verdict}`,
        text: words(
          'change',
          item.kind,
          item.verdict,
          classId ? ctx.className(classId) : undefined,
          item.review?.note,
        ),
        ...onDate(ctx, set.to),
        at: item.review?.at ?? set.createdAt,
        ...itemValue(item),
        status: item.review?.status ?? 'open',
        source: set.producer,
        ...at(itemPlace(ctx, item)),
        evidence: file,
      });
      b.link(is, s, 'in-set');
      if (item.review?.issueId) b.link(is, `issue:${item.review.issueId}`, 'about');
      if (item.kind === 'issue') {
        if (item.from) b.link(is, `issue:${item.from}`, 'about');
        if (item.to) b.link(is, `issue:${item.to}`, 'about');
      }
      if (item.kind === 'detection') {
        for (const d of [...(item.fromIds ?? []), ...(item.toIds ?? [])]) {
          b.link(is, `detection:${d}`, 'about');
        }
      }
    }
  }
}

function thermalFacts(b: Builder, ctx: Context, src: ProjectSources): void {
  for (const h of src.thermal?.hotspots ?? []) {
    const s = `hotspot:${h.id}`;
    const first = h.sightings[0];
    const photo = first ? ctx.photo(first.layer, first.photo) : undefined;
    b.add({
      id: s,
      kind: 'hotspot',
      subject: s,
      label: h.note ? h.note.slice(0, 120) : `Hot spot ${h.id}`,
      text: words(
        'thermal hot spot',
        h.origin,
        `peak ${h.peakC.toFixed(1)} C`,
        `delta ${h.deltaC.toFixed(1)} C`,
        h.note,
      ),
      ...onDate(ctx, photo?.capture),
      value: h.peakC,
      unit: 'degC',
      status: h.state,
      source: h.origin === 'manual' ? 'human' : 'pipeline',
      ...at(photo?.pos),
      evidence: 'thermal/thermal.json',
    });
    for (const sg of h.sightings) {
      const p = ctx.photo(sg.layer, sg.photo);
      if (p) b.link(s, p.subject, 'on-photo');
    }
    if (photo?.capture) b.link(s, `survey:${photo.capture}`, 'on-survey');
    if (h.issueId) b.link(s, `issue:${h.issueId}`, 'issue');
  }
  (src.candidates?.candidates ?? []).forEach((c, i) => {
    const s = `hotspot:candidate/${i}`;
    const photo = ctx.photo(c.layer, c.photo);
    b.add({
      id: s,
      kind: 'hotspot',
      subject: s,
      label: `Hot spot candidate ${i + 1}`,
      text: words('thermal hot spot candidate', `peak ${c.peakC.toFixed(1)} C`),
      ...onDate(ctx, photo?.capture),
      ...(src.candidates?.at ? { at: src.candidates.at } : {}),
      value: c.peakC,
      unit: 'degC',
      status: 'candidate',
      source: 'pipeline',
      ...at(photo?.pos),
      evidence: 'thermal/candidates.json',
    });
    if (photo) b.link(s, photo.subject, 'on-photo');
  });
}

function walkFacts(b: Builder, ctx: Context, src: ProjectSources): void {
  for (const { file, walk } of src.walks) {
    const s = `walk:${walk.id}`;
    const capture = ctx.layerCapture.get(walk.id);
    b.add({
      id: s,
      kind: 'walk',
      subject: s,
      label: walk.name,
      text: words('360 walk', walk.source.file),
      ...onDate(ctx, capture),
      at: walk.createdAt,
      value: walk.video.durationS,
      unit: 's',
      source: 'human',
      evidence: file,
    });
  }
}

function eventFacts(b: Builder, events: readonly AuditEntry[]): void {
  for (const e of events) {
    const subject = subjectOfTarget(e.target);
    b.add({
      id: `event:${e.op}`,
      kind: 'event',
      subject,
      label: e.label ?? e.kind,
      text: words(e.kind, e.actor.name, e.how),
      date: e.at.slice(0, 10),
      at: e.at,
      status: e.state,
      source: e.how,
      evidence: e.chain ? `journal/ops/${e.chain}` : 'journal',
      op: e.op,
    });
  }
}

/** Point things inside a polygon measurement on the same date (or any date for a site one). */
function spatialLinks(b: Builder, measurements: readonly SurveyMeasurement[]): void {
  const POINT_KINDS: ReadonlySet<FactKind> = new Set(['detection', 'issue', 'hotspot', 'change']);
  const polys = measurements.flatMap((m) => {
    if (m.family !== 'polygon') return [];
    const ring = m.points;
    if (ring.length < 3) return [];
    return [{ m }];
  });
  if (!polys.length) return;
  for (const f of b.facts.values()) {
    if (!POINT_KINDS.has(f.kind) || f.e === undefined || f.n === undefined) continue;
    for (const { m } of polys) {
      const ring = ringOn(m, f.capture);
      if (!ring) continue;
      let minE = Infinity;
      let maxE = -Infinity;
      let minN = Infinity;
      let maxN = -Infinity;
      for (const p of ring) {
        minE = Math.min(minE, p[0]);
        maxE = Math.max(maxE, p[0]);
        minN = Math.min(minN, p[1]);
        maxN = Math.max(maxN, p[1]);
      }
      if (f.e < minE || f.e > maxE || f.n < minN || f.n > maxN) continue;
      if (inside(f.e, f.n, ring)) b.link(f.subject, `measurement:${m.id}`, 'inside');
    }
  }
}

/** Every fact and link of a project. */
export function extractFacts(src: ProjectSources): Extracted {
  const b = new Builder();
  const ctx = new Context(src.manifest);
  manifestFacts(b, ctx);
  measurementFacts(b, ctx, src.measurements);
  detectionFacts(b, ctx, src);
  issueFacts(b, ctx, src.issues);
  qaFacts(b, ctx, src);
  changeFacts(b, ctx, src);
  thermalFacts(b, ctx, src);
  walkFacts(b, ctx, src);
  eventFacts(b, src.events);
  spatialLinks(b, src.measurements);
  return b.done();
}
