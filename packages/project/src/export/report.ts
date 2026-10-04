import type { Issue, Vec3 } from '@aio/schema';
import {
  bestPhoto,
  classInfo,
  compareCodes,
  issueLocation,
  issuePosition,
  issueZone,
  noDashes,
  severityInfo,
  severityModelOf,
  type ExportContext,
  type PhotoPick,
} from './facts';

export interface CountRow {
  label: string;
  color: string;
  count: number;
}

export interface ReportRow {
  id: string;
  code: string;
  title: string;
  classLabel: string;
  classColor: string;
  severity: number | 'uncertain';
  severityLabel: string;
  severityColor: string;
  status: string;
  zone: string;
  /** "E 245724.000, N 3179562.000, H 102.0 (EPSG:32639)" or empty. */
  coords: string;
  wgs84: string;
  note: string;
  author: string;
  updatedAt: string;
  sightings: number;
  photo: PhotoPick | null;
  /** Local frame position for the 3D snapshot. */
  position: Vec3 | null;
  /** Mesh normal at the position when the sighting has one, to look at the surface. */
  normal: Vec3 | null;
}

export interface ReportModel {
  title: string;
  customer: string;
  site: string;
  brandName: string;
  date: string;
  crs: string;
  captureLabel: string;
  total: number;
  bySeverity: CountRow[];
  byClass: CountRow[];
  byZone: { zone: string; count: number }[];
  byStatus: { status: string; count: number }[];
  rows: ReportRow[];
}

const rank = (i: Issue) => (i.severity === 'uncertain' ? -1 : i.severity);

function normalOf(issue: Issue): Vec3 | null {
  for (const s of issue.sightings) if (s.on === 'mesh' && s.geom.type === 'spoint') return s.geom.n;
  return null;
}

/** Everything the issue register report shows, ready to lay out. Text has no em or en dashes. */
export function reportModel(
  ctx: ExportContext,
  opts: { brandName: string; now?: Date },
): ReportModel {
  const m = ctx.manifest;
  const now = opts.now ?? new Date();
  const crs = 'epsg' in m.crs ? `EPSG:${String(m.crs.epsg)}` : 'project CRS';
  const issues = [...ctx.issues].sort((a, b) => rank(b) - rank(a) || compareCodes(a.code, b.code));

  const bySeverity: CountRow[] = [];
  const models = m.severityModels.filter((s) => ctx.issues.some((i) => i.severityModelId === s.id));
  for (const model of models) {
    for (const l of [...model.levels].reverse()) {
      bySeverity.push({
        label: models.length > 1 ? `${l.label} (${model.name})` : l.label,
        color: l.color,
        count: ctx.issues.filter((i) => i.severityModelId === model.id && i.severity === l.value)
          .length,
      });
    }
  }
  const uncertain = ctx.issues.filter((i) => i.severity === 'uncertain');
  if (uncertain.length > 0) {
    const first = uncertain[0];
    const u = first ? severityModelOf(m, first)?.uncertain : undefined;
    bySeverity.push({
      label: u?.label ?? 'Uncertain',
      color: u?.color ?? '#b68ef8',
      count: uncertain.length,
    });
  }

  const classCounts = new Map<string, number>();
  for (const i of ctx.issues) classCounts.set(i.classId, (classCounts.get(i.classId) ?? 0) + 1);
  const byClass = [...classCounts]
    .map(([id, count]) => ({ ...classInfo(m, id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const zoneCounts = new Map<string, number>();
  for (const i of ctx.issues) {
    const z = noDashes(issueZone(i));
    zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  }
  const byZone = [...zoneCounts]
    .map(([zone, count]) => ({ zone, count }))
    .sort((a, b) => b.count - a.count || compareCodes(a.zone, b.zone));

  const byStatus = (['draft', 'reviewed', 'approved', 'closed'] as const).map((status) => ({
    status,
    count: ctx.issues.filter((i) => i.status === status).length,
  }));

  const rows: ReportRow[] = issues.map((issue) => {
    const sev = severityInfo(m, issue);
    const cls = classInfo(m, issue.classId);
    const loc = issueLocation(m, issue);
    const coords = loc
      ? `E ${loc.project[0].toFixed(2)}, N ${loc.project[1].toFixed(2)}${
          loc.project[2] === null ? '' : `, H ${loc.project[2].toFixed(2)}`
        } (${crs})`
      : '';
    const wgs84 = loc?.wgs84
      ? `${loc.wgs84[1].toFixed(7)}, ${loc.wgs84[0].toFixed(7)} (WGS84)`
      : '';
    return {
      id: issue.id,
      code: issue.code,
      title: noDashes(issue.title),
      classLabel: noDashes(cls.label),
      classColor: cls.color,
      severity: issue.severity,
      severityLabel: noDashes(sev.label),
      severityColor: sev.color,
      status: issue.status,
      zone: noDashes(issueZone(issue)),
      coords,
      wgs84,
      note: noDashes(issue.note),
      author: noDashes(issue.author),
      updatedAt: issue.updatedAt.slice(0, 10),
      sightings: issue.sightings.length,
      photo: bestPhoto(m, issue),
      position: issuePosition(issue),
      normal: normalOf(issue),
    };
  });

  const capture = m.captures.at(-1);
  return {
    title: noDashes(m.name),
    customer: noDashes(m.customer ?? ''),
    site: noDashes(m.site ?? ''),
    brandName: noDashes(opts.brandName),
    date: now.toISOString().slice(0, 10),
    crs,
    captureLabel: capture ? noDashes(`${capture.label}, ${capture.date}`) : '',
    total: ctx.issues.length,
    bySeverity,
    byClass: byClass.map((c) => ({ ...c, label: noDashes(c.label) })),
    byZone,
    byStatus,
    rows,
  };
}
