import type { Vec3 } from '@aio/schema';
import {
  imageBox,
  issueLocation,
  issuePosition,
  issueZone,
  severityInfo,
  sortByCode,
  type ExportContext,
} from './facts';

export interface KitFinding {
  id: string;
  photo: string;
  class: string;
  /** Kit grade; null for uncertain. */
  severity: number | null;
  /** [x0, y0, x1, y1] in review-copy pixels. */
  bbox: [number, number, number, number];
  note: string;
  confidence: null;
  component: null;
  /** The issue code the finding belongs to. */
  group: string;
}

export interface KitIssue {
  id: string;
  code: string;
  title: string;
  class: string;
  severity: number | null;
  severity_label: string;
  status: string;
  zone: string;
  note: string;
  /** Local frame (x east, y up, z south), metres. */
  position_local: Vec3 | null;
  /** Project CRS E, N, H. */
  position_crs: [number, number, number | null] | null;
}

/** Asset Inspection Kit `assessment.json`, plus an `issues` list for issues without photos. */
export interface KitAssessment {
  method: string;
  status: string;
  photos: Record<string, { status: 'finding' | 'uncertain' | 'none'; note: string }>;
  findings: KitFinding[];
  issues: KitIssue[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function issuesKitAssessment(ctx: ExportContext, now = new Date()): KitAssessment {
  const m = ctx.manifest;
  const photos: KitAssessment['photos'] = {};
  for (const l of m.layers)
    if (l.kind === 'photos') for (const p of l.items) photos[p.id] = { status: 'none', note: '' };
  const notes = new Map<string, string[]>();
  const findings: KitFinding[] = [];
  const perPhoto = new Map<string, number>();
  const issues: KitIssue[] = [];

  for (const issue of sortByCode(ctx.issues)) {
    const severity = issue.severity === 'uncertain' ? null : issue.severity;
    const sev = severityInfo(m, issue);
    const loc = issueLocation(m, issue);
    issues.push({
      id: issue.id,
      code: issue.code,
      title: issue.title,
      class: issue.classId,
      severity,
      severity_label: sev.label,
      status: issue.status,
      zone: issueZone(issue),
      note: issue.note,
      position_local: issuePosition(issue),
      position_crs: loc?.project ?? null,
    });
    for (const s of issue.sightings) {
      if (s.on !== 'image') continue;
      const prev = photos[s.photo];
      const status = issue.severity === 'uncertain' ? 'uncertain' : 'finding';
      if (prev?.status !== 'finding') photos[s.photo] = { status, note: '' };
      const list = notes.get(s.photo) ?? [];
      if (!list.includes(issue.title)) list.push(issue.title);
      notes.set(s.photo, list);
      const box = imageBox(s.geom);
      if (!box) continue;
      const n = (perPhoto.get(s.photo) ?? 0) + 1;
      perPhoto.set(s.photo, n);
      findings.push({
        id: `${s.photo}-${String(n)}`,
        photo: s.photo,
        class: issue.classId,
        severity,
        bbox: [r1(box[0]), r1(box[1]), r1(box[0] + box[2]), r1(box[1] + box[3])],
        note: issue.note.split('\n')[0] ?? '',
        confidence: null,
        component: null,
        group: issue.code,
      });
    }
  }
  for (const [photo, list] of notes) {
    const entry = photos[photo];
    if (entry) entry.note = list.join('; ');
  }
  return {
    method: `Issue register of ${m.name}, exported ${now.toISOString().slice(0, 10)}`,
    status: 'exported',
    photos,
    findings,
    issues,
  };
}
