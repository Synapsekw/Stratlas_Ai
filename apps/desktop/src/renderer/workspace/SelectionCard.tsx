import type { Issue, Layer, ProjectManifest, Vec3 } from '@aio/schema';
import {
  crsLabel,
  formatClock,
  formatCompact,
  formatDate,
  formatDuration,
  formatEastNorth,
  formatLocal,
  Icon,
  localToProject,
  SevChip,
  severityColor,
  type IconName,
} from '@aio/ui';
import { interpolatePose } from '@aio/video';
import { useWorkspace, workspace, type Selection } from '@aio/workspace';
import { useEffect, type ReactNode } from 'react';
import { LayerDatePicker } from '../change/SurveyDate';
import { loadFlight, useMedia } from '../media';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

const KIND: Record<Layer['kind'], { label: string; icon: IconName }> = {
  mesh: { label: 'Model', icon: 'scene' },
  legacy: { label: 'Legacy viewer', icon: 'scene' },
  pointcloud: { label: 'Point cloud', icon: 'cloud' },
  basemap: { label: 'Offline basemap', icon: 'map' },
  raster: { label: 'Raster', icon: 'raster' },
  vector: { label: 'Map overlay', icon: 'map' },
  video: { label: 'Video clip', icon: 'video' },
  photos: { label: 'Photo set', icon: 'photo' },
  panoramas: { label: 'Panoramas', icon: 'pano' },
};

interface CardModel {
  kindLabel: string;
  icon: IconName;
  title: string;
  subtitle: string;
  position?: Vec3 | undefined;
  rows: [string, ReactNode][];
  chips?: ReactNode;
}

function firstPoint(issue: Issue): Vec3 | undefined {
  for (const s of issue.sightings) {
    if (s.on === 'mesh' && s.geom.type === 'spoint') return s.geom.p;
    if (s.on === 'mesh' && (s.geom.type === 'spolyline' || s.geom.type === 'spolygon'))
      return s.geom.points[0];
    if (s.on === 'mesh' && s.geom.type === 'spatch') return s.geom.center;
    if (s.on === 'pointcloud' && s.geom.type === 'point3') return s.geom.p;
  }
  return undefined;
}

function describe(
  sel: Selection | null,
  m: ProjectManifest,
  issues: readonly Issue[],
  nowMs: number,
  durations: Record<string, number>,
  flights: ReturnType<typeof useMedia>['flights'],
): CardModel {
  const layer = m.layers.find((l) => l.id === (sel?.layer ?? sel?.id));
  if (sel?.kind === 'issue') {
    const issue = issues.find((i) => i.id === sel.id);
    if (issue) {
      const model = m.severityModels.find((x) => x.id === issue.severityModelId);
      const level =
        issue.severity === 'uncertain'
          ? model?.uncertain?.label
          : model?.levels.find((l) => l.value === issue.severity)?.label;
      const cls = m.classCatalogues.flatMap((c) => c.classes).find((c) => c.id === issue.classId);
      return {
        kindLabel: 'Issue',
        icon: 'issues',
        title: `${issue.code} · ${issue.title}`,
        subtitle: `${cls?.label ?? issue.classId} · ${issue.status}`,
        position: firstPoint(issue),
        chips: (
          <SevChip color={severityColor(m.severityModels, issue.severityModelId, issue.severity)}>
            {String(issue.severity)}
            {level ? ` ${level}` : ''}
          </SevChip>
        ),
        rows: [
          ['Sightings', String(issue.sightings.length)],
          ['Author', `${issue.author} · ${formatDate(issue.updatedAt)}`],
          ['Source', issue.source],
        ],
      };
    }
  }
  if (sel?.kind === 'clip' && layer?.kind === 'video') {
    const v: VideoLayer = layer;
    const start = v.flight.startUtcMs + v.offsetMs;
    const dur = durations[v.id];
    const samples = flights[v.id];
    const pose = samples?.length
      ? interpolatePose(samples, nowMs - v.flight.startUtcMs)
      : undefined;
    return {
      kindLabel: 'Video clip',
      icon: 'video',
      title: v.name,
      subtitle: `${v.lens.model === 'ftheta' ? 'f-theta' : 'pinhole'} ${String(v.lens.hfovDeg)}° lens`,
      position: pose?.pos,
      rows: [
        ['Starts', `${formatDate(new Date(start).toISOString())} · ${formatClock(start)} UTC`],
        ['Length', dur !== undefined ? formatDuration(dur) : 'Reading video'],
        ['Drone', pose ? 'Position at the playhead' : 'No flight log loaded'],
      ],
    };
  }
  if (sel?.kind === 'photo' && layer?.kind === 'photos') {
    const photo = layer.items.find((p) => p.id === sel.id);
    return {
      kindLabel: 'Photo',
      icon: 'photo',
      title: photo?.id ?? sel.id,
      subtitle: layer.name,
      position: photo?.pos,
      rows: [
        [
          'Taken',
          photo?.takenAt
            ? // the day and the clock both in UTC, as labelled
              `${formatDate(new Date(Date.parse(photo.takenAt)).toISOString())} · ${formatClock(Date.parse(photo.takenAt))} UTC`
            : 'Unknown',
        ],
      ],
    };
  }
  if (sel?.kind === 'pano' && layer?.kind === 'panoramas') {
    const pano = layer.items.find((p) => p.id === sel.id);
    return {
      kindLabel: 'Panorama',
      icon: 'pano',
      title: pano?.id ?? sel.id,
      subtitle: layer.name,
      position: pano?.pos,
      rows: [['Heading', pano ? `${String(pano.headingDeg)}°` : 'Unknown']],
    };
  }
  if (sel?.kind === 'asset' && layer?.kind === 'mesh') {
    const tag = layer.tags?.find((t) => t.node === sel.id || t.tag === sel.id);
    return {
      kindLabel: 'Asset',
      icon: 'scene',
      title: tag?.tag ?? sel.id,
      subtitle: [tag?.area, layer.name].filter(Boolean).join(' · '),
      rows: [['Node', <span className="mono">{sel.id}</span>]],
    };
  }
  if (layer) {
    const k = KIND[layer.kind];
    const rows: [string, ReactNode][] = [
      ['Visible', workspace.getState().hidden[layer.id] ? 'Hidden' : 'Shown'],
    ];
    if (layer.kind === 'pointcloud')
      rows.push([
        'Points',
        layer.pointCount !== undefined ? formatCompact(layer.pointCount) : layer.format,
      ]);
    if (layer.kind === 'raster') rows.push(['Role', `${layer.role} · ${layer.format}`]);
    if (layer.kind === 'basemap') rows.push(['Pack', <span className="mono">{layer.pack}</span>]);
    if (layer.kind === 'photos' || layer.kind === 'panoramas')
      rows.push(['Items', String(layer.items.length)]);
    if (layer.kind === 'mesh' && layer.tags) rows.push(['Tagged nodes', String(layer.tags.length)]);
    return { kindLabel: k.label, icon: k.icon, title: layer.name, subtitle: k.label, rows };
  }
  const capture = m.captures.at(-1);
  return {
    kindLabel: 'Project',
    icon: 'layers',
    title: m.name,
    subtitle: [m.customer, m.site].filter(Boolean).join(' · ') || 'Project',
    rows: [
      [
        'Last capture',
        capture ? `${formatDate(capture.date)} · ${capture.label}` : 'None recorded',
      ],
      ['CRS', crsLabel(m.crs)],
    ],
    position: [0, 0, 0],
  };
}

export function SelectionCard() {
  const project = useWorkspace((s) => s.project);
  const selection = useWorkspace((s) => s.selection);
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => (s.selection?.kind === 'clip' ? s.nowMs : 0));
  const { durations, flights } = useMedia(project);
  useEffect(() => {
    if (!project || selection?.kind !== 'clip') return;
    const layer = project.manifest.layers.find((l) => l.id === selection.id);
    if (layer?.kind === 'video') loadFlight(project, layer);
  }, [project, selection]);
  if (!project) return null;
  const m = project.manifest;

  const card = describe(selection, m, issues, nowMs, durations, flights);
  const clips = m.layers.filter((l) => l.kind === 'video').length;
  const open = issues.filter((i) => i.status !== 'closed');
  const photos = m.layers.reduce((n, l) => n + (l.kind === 'photos' ? l.items.length : 0), 0);
  const project3 = card.position ? localToProject(m.origin, card.position) : null;
  const sevCounts = m.severityModels[0]?.levels
    .map((lv) => ({ lv, n: open.filter((i) => i.severity === lv.value).length }))
    .filter((x) => x.n > 0)
    .reverse();

  return (
    <section className="ctx" aria-label="Selection">
      <div className="panel-h">
        <h2>Selection</h2>
        <span className="sub">{card.kindLabel}</span>
        <div className="acts">
          <button
            type="button"
            className="btn icon sm ghost"
            title="Fly to"
            aria-label="Fly to the selection"
            onClick={() => {
              workspace
                .getState()
                .flyTo(selection ? { kind: 'selection', selection } : { kind: 'home' });
            }}
          >
            <Icon name="target" size={14} />
          </button>
          {selection && (
            <button
              type="button"
              className="btn icon sm ghost"
              title="Clear selection"
              aria-label="Clear selection"
              onClick={() => {
                workspace.getState().select(null);
              }}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="ctx-body">
        <div className="ent-h">
          <div className="ent-ic">
            <Icon name={card.icon} size={20} />
          </div>
          <div className="et">
            <b>{card.title}</b>
            <span>{card.subtitle}</span>
          </div>
        </div>
        {card.chips && <div className="ent-chips">{card.chips}</div>}
        <LayerDatePicker />
        <div className="mini-stats">
          <div>
            <div className="v">{clips}</div>
            <div className="k">Clips</div>
          </div>
          <div>
            <div className="v sv">
              {open.length}
              {sevCounts && sevCounts.length > 0 && (
                <span className="sevbar">
                  {sevCounts.map(({ lv, n }) => (
                    <i key={lv.value} style={{ flex: n, background: lv.color }} />
                  ))}
                </span>
              )}
            </div>
            <div className="k">Open issues</div>
          </div>
          <div>
            <div className="v">{formatCompact(photos)}</div>
            <div className="k">Photos</div>
          </div>
        </div>
        <dl className="kv">
          {card.position && project3 ? (
            <>
              <dt>Site frame</dt>
              <dd className="mono">{formatLocal(card.position)}</dd>
              <dt>{crsLabel(m.crs).split(' · ')[0]}</dt>
              <dd className="mono">
                {formatEastNorth(project3[0], project3[1])}
                <br />
                EL {project3[2].toFixed(2)} m
              </dd>
            </>
          ) : (
            <>
              <dt>Position</dt>
              <dd className="faint">Not known for this selection</dd>
            </>
          )}
          {card.rows.map(([k, v]) => (
            <div className="kv-row" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
