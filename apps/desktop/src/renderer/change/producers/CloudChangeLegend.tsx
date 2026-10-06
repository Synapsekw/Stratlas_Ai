/**
 * The change legend under a 3D view (M8 stream C3): the change ramp in metres, the threshold slider
 * and the distance under the pointer (`@aio/pointcloud` ChangeLegend), with the volume change of
 * the same dates read only from C2's `change.surface` set. The cloud and model change producers
 * are registered at start (`registerAppChangeProducers`).
 */
import { ChangeLegend } from '@aio/pointcloud';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { bridge, useJobs, useShell } from '../../shell';
import {
  changeCloudLayers,
  surfaceSetId,
  surfaceVolumes,
  volumeJob,
  type VolumeChange,
} from './cloud';
import { startChangeJob as startJob } from './register';

const m3 = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 1 });

/** The volume change of the dates the shown change cloud compares (C2's output, read only). */
function VolumeChangeRow() {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const surfaceRuns = useJobs(
    (s) => s.jobs.filter((j) => j.pipeline === 'change.surface' && j.status === 'done').length,
  );
  const layers = project ? changeCloudLayers(project.manifest.layers) : [];
  const layer = layers.find((l) => l.visible) ?? layers[0];
  const from = layer?.derived?.from;
  const to = layer?.derived?.to;
  const projectId = project?.id;
  const [note, setNote] = useState<string | null>(null);
  // the set read for this project, date pair and number of finished surface runs
  const key = projectId && from && to ? [projectId, from, to, surfaceRuns].join('|') : null;
  const [read, setRead] = useState<{ key: string; volume: VolumeChange | null } | null>(null);

  useEffect(() => {
    if (!key || !projectId || !from || !to) return;
    let live = true;
    void bridge.call('change:read', { projectId, id: surfaceSetId(from, to) }).then((r) => {
      if (live) setRead({ key, volume: r.ok && r.value.ok ? surfaceVolumes(r.value.set) : null });
    });
    return () => {
      live = false;
    };
  }, [key, projectId, from, to]);
  const volume = read?.key === key ? read.volume : null;

  if (!project || !layer || !from || !to) return null;
  const run = async () => {
    const [a, b] = layer.derived?.source ?? [];
    const byId = (id: string | undefined) => project.manifest.layers.filter((l) => l.id === id);
    const job = volumeJob(
      {
        projectId: project.id,
        manifest: project.manifest,
        from,
        to,
        layersFrom: byId(a),
        layersTo: byId(b),
      },
      project.root,
    );
    if (typeof job === 'string') {
      setNote(job);
      return;
    }
    const r = await startJob(job);
    setNote('error' in r ? r.error : t('cloudChange.volume.started'));
  };
  return (
    <div
      role="group"
      aria-label={t('cloudChange.volume.title')}
      data-testid="cloud-volume-change"
      style={{ display: 'grid', gap: 4, marginTop: 4 }}
    >
      <span style={{ color: 'var(--fg-1, #d6dbe3)' }}>{t('cloudChange.volume.title')}</span>
      {volume ? (
        <span>
          {t('cloudChange.volume.totals', {
            fill: m3(volume.fillM3),
            cut: m3(volume.cutM3),
            net: m3(volume.netM3),
          })}
        </span>
      ) : (
        <span>{t('cloudChange.volume.none')}</span>
      )}
      {!volume &&
        (pkg ? (
          <span>{t('cloudChange.volume.package')}</span>
        ) : (
          <button type="button" className="btn" onClick={() => void run()}>
            {t('cloudChange.volume.run')}
          </button>
        ))}
      {note && <span role="status">{note}</span>}
    </div>
  );
}

/** Mounted beside the elevation and class legends of a 3D view. */
export function CloudChangeLegend() {
  return (
    <ChangeLegend className="elev-legend class-legend overlay-box">
      <VolumeChangeRow />
    </ChangeLegend>
  );
}
