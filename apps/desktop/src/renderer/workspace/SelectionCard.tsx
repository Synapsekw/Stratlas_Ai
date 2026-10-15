import type { ComponentDimension, ComponentInfo } from '@aio/engine';
import { clipKeys, correctedPhoto, looksEstimated, photoCorrection } from '@aio/geo';
import type { Issue, Layer, OrientationFile, PoseSample, ProjectManifest, Vec3 } from '@aio/schema';
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
  useT,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { interpolatePose } from '@aio/video';
import { useWorkspace, workspace, type Selection } from '@aio/workspace';
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { alignCamera } from '../builder/alignSession';
import { LayerDatePicker } from '../change/SurveyDate';
import { loadFlight, useMedia } from '../media';
import {
  LayerComponents,
  setComponentVisible,
  useHiddenComponents,
  useLayerComponents,
} from './ComponentList';
import { SpotHistoryButton } from './spot/SpotHistoryEntry';
import type { SpotOpen } from './spot/spotTypes';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** Shown on clips whose camera direction was estimated at import (no gimbal angles). */
const ESTIMATED_HINT =
  'Camera direction estimated from the flight path (no gimbal data in this SRT). Fix it with Align camera to map, or right-click the drone.';

/** The clip's camera row: where its direction comes from, and the way to set it. */
function cameraRow(
  v: VideoLayer,
  estimated: boolean,
  orientation: OrientationFile | null,
): [string, ReactNode][] {
  const keys = clipKeys(orientation, v.id)?.length ?? 0;
  if (!keys && !estimated) return [];
  return [
    [
      'Camera',
      <span className="cam-row">
        <span>
          {keys
            ? `Set by hand: ${String(keys)} direction keyframe${keys === 1 ? '' : 's'}`
            : ESTIMATED_HINT}
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            alignCamera.getState().start(v.id);
          }}
          data-testid="card-align-camera"
        >
          <Icon name="droneeye" size={12} />
          Align camera to map
        </button>
      </span>,
    ],
  ];
}

const estimatedLogs = new WeakMap<readonly PoseSample[], boolean>();
/** The log's camera orientation was estimated, once per log (the card redraws with the clock). */
function isEstimated(samples: readonly PoseSample[]): boolean {
  let v = estimatedLogs.get(samples);
  if (v === undefined) {
    v = looksEstimated(samples);
    estimatedLogs.set(samples, v);
  }
  return v;
}

const KIND: Record<Layer['kind'], { label: string; icon: IconName }> = {
  mesh: { label: 'Model', icon: 'scene' },
  // retired (11 Oct 2026): nothing selects it any more, the entry stays for the type
  legacy: { label: 'Retired viewer', icon: 'scene' },
  pointcloud: { label: 'Point cloud', icon: 'cloud' },
  basemap: { label: 'Offline basemap', icon: 'map' },
  raster: { label: 'Raster', icon: 'raster' },
  vector: { label: 'Map overlay', icon: 'map' },
  video: { label: 'Video clip', icon: 'video' },
  walk: { label: '360 walk', icon: 'pano' },
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

/** The spot viewer's entry for a selected photo or panorama (its layer resolved as the viewers do). */
function spotOpenOf(sel: Selection | null, m: ProjectManifest): SpotOpen | null {
  if (sel?.kind === 'photo') {
    const layer = sel.layer ?? m.layers.find((l) => l.kind === 'photos')?.id;
    return layer ? { item: { kind: 'photo', layer, photo: sel.id } } : null;
  }
  if (sel?.kind === 'pano') {
    const layer = sel.layer ?? m.layers.find((l) => l.kind === 'panoramas')?.id;
    return layer ? { item: { kind: 'pano', layer, pano: sel.id } } : null;
  }
  return null;
}

function describe(
  sel: Selection | null,
  m: ProjectManifest,
  issues: readonly Issue[],
  nowMs: number,
  durations: Record<string, number>,
  flights: ReturnType<typeof useMedia>['flights'],
  orientation: OrientationFile | null,
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
        ...cameraRow(v, !!samples && !v.orientation && isEstimated(samples), orientation),
      ],
    };
  }
  if (sel?.kind === 'photo' && layer?.kind === 'photos') {
    const found = layer.items.find((p) => p.id === sel.id);
    const photo = found
      ? correctedPhoto(found, photoCorrection(orientation, layer.id, found.id))
      : undefined;
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

const BASIS: Record<string, MessageKey> = {
  measured: 'component.basis.measured',
  observed: 'component.basis.observed',
  inferred: 'component.basis.inferred',
  user: 'component.basis.user',
};
const STATUS: Record<string, MessageKey> = {
  draft: 'component.status.draft',
  accepted: 'component.status.accepted',
  rejected: 'component.status.rejected',
};
const SURFACE: Record<string, MessageKey> = {
  back: 'component.surface.back',
  top: 'component.surface.top',
  interior: 'component.surface.interior',
  base: 'component.surface.base',
};

/** "lensDiameter", "lens_diameter" and "lens-diameter" read "Lens diameter"; "yawDeg" reads "Yaw". */
export function paramLabel(key: string): string {
  const words = key
    // the unit is shown with the value
    .replace(/(.)Deg$/, '$1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A dimension as read: "32.4 m", "1.2 × 0.8 m", "270°". */
export function formatDimension(d: ComponentDimension): string {
  const n = (v: number) => String(Number(v.toFixed(3)));
  const value = Array.isArray(d.value) ? d.value.map(n).join(' × ') : n(d.value);
  return d.unit === 'deg' ? `${value}°` : `${value} ${d.unit}`;
}

/** Coverage in words: the panel never shows a share as a percentage. */
function coverageKey(c: number): MessageKey {
  return c >= 0.8
    ? 'component.coverage.good'
    : c >= 0.4
      ? 'component.coverage.partial'
      : 'component.coverage.sparse';
}

/** Escape in the card clears the selection (a text field keeps its own Escape). */
function clearOnEscape(e: ReactKeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const el = e.target as HTMLElement;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
  if (!workspace.getState().selection) return;
  e.preventDefault();
  workspace.getState().select(null);
}

/**
 * The selection card of an engineering model component: what it is, how each value is known, the
 * fit and coverage of the evidence (in words), the sides no evidence saw, and Focus, Clear and
 * the layer's component list.
 */
function ComponentCard({
  info,
  layer,
  selection,
  all,
  provisional,
}: {
  info: ComponentInfo;
  layer: Layer;
  selection: Selection;
  all: readonly ComponentInfo[];
  /** The model's scale is provisional: its lengths are not true metres yet. */
  provisional: boolean;
}) {
  const t = useT();
  const hidden = useHiddenComponents(layer.id).has(info.id);
  const q = info.quality;
  const dims = info.dimensions ?? {};
  // every value: its dimension (when it has one) and how it is known
  const keys = [...new Set([...Object.keys(dims), ...Object.keys(q?.params ?? {})])];
  const parent = info.parent ? (all.find((c) => c.id === info.parent)?.name ?? info.parent) : null;
  const label = (keys: Record<string, MessageKey>, v: string) => {
    const key = keys[v];
    return key ? t(key) : paramLabel(v);
  };
  const basis = (b: string | undefined) =>
    !b
      ? ''
      : provisional && b === 'measured'
        ? t('component.basis.measuredProvisional')
        : label(BASIS, b);
  const valueText = (k: string) => {
    const d = dims[k];
    const shown = d
      ? provisional && d.unit === 'm'
        ? t('component.card.provisionalValue', { value: formatDimension(d) })
        : formatDimension(d)
      : '';
    return [shown, basis(q?.params[k])].filter(Boolean).join(' · ');
  };
  const status = info.status ? STATUS[info.status] : undefined;
  return (
    <section
      className="ctx comp-card"
      aria-label={t('component.card.kind')}
      data-testid="component-card"
      onKeyDown={clearOnEscape}
    >
      <div className="panel-h">
        <h2>{t('selection.title')}</h2>
        <span className="sub">{t('component.card.kind')}</span>
      </div>
      <div className="ctx-body">
        <div className="ent-h">
          <div className="ent-ic">
            <Icon name="box" size={20} />
          </div>
          <div className="et">
            <b>{info.name}</b>
            <span>{[info.category, layer.name].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        {info.description && <p className="comp-desc">{info.description}</p>}
        <div className="comp-acts">
          <button
            type="button"
            className="btn sm"
            data-testid="component-focus"
            onClick={() => {
              workspace.getState().flyTo({ kind: 'selection', selection });
            }}
          >
            <Icon name="target" size={12} />
            {t('component.card.focus')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            data-testid="component-clear"
            onClick={() => {
              workspace.getState().select(null);
            }}
          >
            <Icon name="x" size={12} />
            {t('component.card.clear')}
          </button>
        </div>
        {hidden && (
          <div className="comp-hidden">
            <span>{t('component.card.hidden')}</span>
            <button
              type="button"
              className="btn sm"
              data-testid="component-show"
              onClick={() => {
                setComponentVisible(layer.id, info.id, true);
              }}
            >
              <Icon name="eye" size={12} />
              {t('component.card.show')}
            </button>
          </div>
        )}
        <dl className="kv">
          <div className="kv-row">
            <dt>{t('component.card.id')}</dt>
            <dd className="mono" data-testid="component-id">
              {info.id}
            </dd>
          </div>
          {info.tag && (
            <div className="kv-row">
              <dt>{t('component.card.tag')}</dt>
              <dd className="mono">{info.tag}</dd>
            </div>
          )}
          {info.basis && (
            <div className="kv-row">
              <dt>{t('component.card.basis')}</dt>
              <dd data-testid="component-basis">{basis(info.basis)}</dd>
            </div>
          )}
          {status && (
            <div className="kv-row">
              <dt>{t('component.card.status')}</dt>
              <dd>{t(status)}</dd>
            </div>
          )}
          {parent && (
            <div className="kv-row">
              <dt>{t('component.card.mountedOn')}</dt>
              <dd>{parent}</dd>
            </div>
          )}
          {provisional && (
            <div className="kv-row">
              <dt>{t('component.card.scale')}</dt>
              <dd data-testid="component-scale">{t('component.card.scaleProvisional')}</dd>
            </div>
          )}
          {keys.length > 0 && (
            <div className="kv-row">
              <dt>{t('component.card.values')}</dt>
              <dd>
                <ul className="comp-values">
                  {keys.map((k) => (
                    <li key={k} data-testid="component-value">
                      <span>{paramLabel(k)}</span>
                      <span>{valueText(k)}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {q?.residualM !== undefined && (
            <div className="kv-row">
              <dt>{t('component.card.fit')}</dt>
              <dd>
                {t('component.card.fitValue', {
                  mm: String(Math.max(1, Math.round(q.residualM * 1000))),
                })}
              </dd>
            </div>
          )}
          {q?.coverage !== undefined && (
            <div className="kv-row">
              <dt>{t('component.card.coverage')}</dt>
              <dd>{t(coverageKey(q.coverage))}</dd>
            </div>
          )}
          {info.unobserved && info.unobserved.length > 0 && (
            <div className="kv-row">
              <dt>{t('component.card.unobserved')}</dt>
              <dd>{info.unobserved.map((s) => label(SURFACE, s)).join(', ')}</dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}

export function SelectionCard() {
  const project = useWorkspace((s) => s.project);
  const selection = useWorkspace((s) => s.selection);
  // an engineering model's components (empty for any other selection)
  const meshLayer = project?.manifest.layers.find(
    (l) =>
      l.kind === 'mesh' &&
      ((selection?.kind === 'asset' && l.id === selection.layer) ||
        (selection?.kind === 'layer' && l.id === selection.id)),
  );
  const components = useLayerComponents(meshLayer?.id ?? '');
  const component =
    selection?.kind === 'asset' ? components.find((c) => c.id === selection.id) : undefined;
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => (s.selection?.kind === 'clip' ? s.nowMs : 0));
  const orientation = useWorkspace((s) => s.orientation);
  const { durations, flights } = useMedia(project);
  useEffect(() => {
    if (!project || selection?.kind !== 'clip') return;
    const layer = project.manifest.layers.find((l) => l.id === selection.id);
    if (layer?.kind === 'video') loadFlight(project, layer);
  }, [project, selection]);
  if (!project) return null;
  const m = project.manifest;
  // the layer's component list stays in one place below the card, so moving between the layer
  // card and a component card keeps its search text and the focused row
  const list =
    meshLayer && components.length > 0 ? (
      <div className="ctx-body comp-list-host">
        <LayerComponents
          layerId={meshLayer.id}
          selected={selection?.kind === 'asset' ? selection.id : undefined}
        />
      </div>
    ) : null;
  if (component && meshLayer?.kind === 'mesh' && selection)
    return (
      <>
        <ComponentCard
          info={component}
          layer={meshLayer}
          selection={selection}
          all={components}
          provisional={meshLayer.georef?.scale.status === 'provisional'}
        />
        {list}
      </>
    );

  const card = describe(selection, m, issues, nowMs, durations, flights, orientation);
  const spotOpen = spotOpenOf(selection, m);
  const clips = m.layers.filter((l) => l.kind === 'video').length;
  const open = issues.filter((i) => i.status !== 'closed');
  const photos = m.layers.reduce((n, l) => n + (l.kind === 'photos' ? l.items.length : 0), 0);
  const project3 = card.position ? localToProject(m.origin, card.position) : null;
  const sevCounts = m.severityModels[0]?.levels
    .map((lv) => ({ lv, n: open.filter((i) => i.severity === lv.value).length }))
    .filter((x) => x.n > 0)
    .reverse();

  return (
    <>
      <section className="ctx" aria-label={t('selection.title')} onKeyDown={clearOnEscape}>
        <div className="panel-h">
          <h2>{t('selection.title')}</h2>
          <span className="sub">{card.kindLabel}</span>
          <div className="acts">
            {spotOpen && <SpotHistoryButton open={spotOpen} />}
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
      {list}
    </>
  );
}
