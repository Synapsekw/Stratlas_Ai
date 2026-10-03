import type { Issue, IssueClass, SeverityModel, Sighting } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useMemo, type CSSProperties } from 'react';
import { severityColor } from '../tools/mesh';

const EMPTY_MODELS: SeverityModel[] = [];
const EMPTY_CLASSES: IssueClass[] = [];

export interface ProjectTaxonomy {
  models: readonly SeverityModel[];
  classes: readonly IssueClass[];
  classById: ReadonlyMap<string, IssueClass>;
  modelById: ReadonlyMap<string, SeverityModel>;
}

/** Severity models and classes of the open project. */
export function useTaxonomy(): ProjectTaxonomy {
  const models = useWorkspace((s) => s.project?.manifest.severityModels ?? EMPTY_MODELS);
  const catalogues = useWorkspace((s) => s.project?.manifest.classCatalogues);
  return useMemo(() => {
    const classes = catalogues ? catalogues.flatMap((c) => c.classes) : EMPTY_CLASSES;
    return {
      models,
      classes,
      classById: new Map(classes.map((c) => [c.id, c])),
      modelById: new Map(models.map((m) => [m.id, m])),
    };
  }, [models, catalogues]);
}

export function severityLabel(model: SeverityModel | undefined, sev: Issue['severity']): string {
  if (sev === 'uncertain') return model?.uncertain?.label ?? 'Uncertain';
  return model?.levels.find((l) => l.value === sev)?.label ?? '';
}

export const sevStyle = (color: string): CSSProperties => ({ ['--sev' as string]: color });

export function SeverityBadge({
  model,
  severity,
  withLabel = false,
}: {
  model: SeverityModel | undefined;
  severity: Issue['severity'];
  withLabel?: boolean;
}) {
  const label = severityLabel(model, severity);
  return (
    <span
      className={`ann-sev${severity === 'uncertain' ? ' unc' : ''}`}
      style={sevStyle(severityColor(model, severity))}
      title={label}
    >
      <i />
      {severity === 'uncertain' ? '?' : severity}
      {withLabel && label ? ` ${label}` : ''}
    </span>
  );
}

const KIND_LABEL: Record<Sighting['on'], string> = {
  mesh: 'Mesh',
  image: 'Photo',
  video: 'Video',
  pointcloud: 'Cloud',
  map: 'Map',
  pano: 'Pano',
};

export function sightingLabel(s: Sighting): string {
  switch (s.on) {
    case 'image':
      return `${KIND_LABEL.image} ${s.photo} · ${s.geom.type}`;
    case 'video': {
      const t = s.track[0]?.t ?? 0;
      return `${KIND_LABEL.video} ${s.layer} · ${formatClock(t)}${s.track.length > 1 ? ` · ${s.track.length} keys` : ''}`;
    }
    case 'mesh':
      return `${KIND_LABEL.mesh} ${s.layer} · ${s.geom.type.slice(1)}`;
    case 'pointcloud':
      return `${KIND_LABEL.pointcloud} ${s.layer} · ${s.geom.type}`;
    case 'map':
      return `${KIND_LABEL.map} ${s.layer}`;
    case 'pano':
      return `${KIND_LABEL.pano} ${s.pano}`;
  }
}

export const kindLabel = (k: Sighting['on']) => KIND_LABEL[k];

/** m:ss.d */
export function formatClock(tS: number): string {
  const m = Math.floor(tS / 60);
  const s = tS - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
