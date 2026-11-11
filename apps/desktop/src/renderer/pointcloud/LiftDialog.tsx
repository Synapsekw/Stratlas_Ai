/**
 * Classify on point cloud: the photo menu's action (`photos.classifyOnCloud`) and the small dialog
 * it opens. The action shows when the Segmentation add-on is installed and the project has a COPC
 * point cloud; the dialog reads the outlines of the picked photos, asks for the cloud (when there
 * is more than one) and the class, runs `segment.lift` (lift.ts) and says what was added and
 * which outlines were skipped and why. The host is mounted once in App.tsx.
 */
import { imageSizeOf } from '@aio/annotate';
import type { Detection } from '@aio/annotate/detections';
import type { Layer } from '@aio/schema';
import { Dialog, defineAction, registerActions, useT, type PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect, useState, type ReactElement } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { addons, installedOf } from '../addons';
import { detections, loadDetections } from '../detections/store';
import { editBlocked } from '../shell/actions/reasons';
import { defaultJobsDeps } from './cleanupJobs';
import { isCleanable } from './cleanupStore';
import { LIFT_CLASSES, liftable, liftClassName, masksFor, runLift, type LiftOutcome } from './lift';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

const liftDialog = createStore<{ picks: PhotoPick[] | null }>()(() => ({ picks: null }));

/** Open the dialog on these photos (the menu action, tests). */
export function openLiftDialog(picks: PhotoPick[]): void {
  liftDialog.setState({ picks });
}

const cloudsOf = (layers: readonly Layer[]): CloudLayer[] =>
  layers.filter((l): l is CloudLayer => isCleanable(l));

/** The outlines on these photos the review store holds (once it was read for this project). */
function outlinesOn(projectId: string, picks: readonly PhotoPick[]): Detection[] | null {
  const s = detections.getState();
  if (s.projectId !== projectId) return null;
  const on = new Set(picks.map((p) => `${p.layerId}\n${p.photoId}`));
  return s.review.detections.filter(
    (d) =>
      d.source.kind === 'photo' && on.has(`${d.source.layer}\n${d.source.photo}`) && liftable(d),
  );
}

const photoSize = (layer: string, photo: string): [number, number] | null => {
  const s = imageSizeOf(layer, photo);
  return s ? [s[0], s[1]] : null;
};

export const CLASSIFY_ON_CLOUD = defineAction<'photos'>({
  id: 'photos.classifyOnCloud',
  label: 'cleanup.lift.action',
  icon: 'target',
  section: 'edit',
  targets: ['photos'],
  multi: true,
  testId: 'photos-classify-on-cloud',
  appliesTo: (tg, ctx) => {
    // the add-on list is read once, the first time a photo menu asks
    void addons.getState().ensure();
    if (!installedOf(addons.getState(), 'segmenter')) return false;
    if (cloudsOf(ctx.manifest.layers).length === 0) return false;
    // before the review store was read for this project the dialog says when there is no outline
    const found = outlinesOn(ctx.manifest.id, tg.picks);
    return found === null || found.length > 0;
  },
  disabled: (_tg, ctx) => editBlocked(ctx),
  run: (tg) => {
    openLiftDialog(tg.picks);
  },
});

/** Register the photo menu action (once; the registry replaces an id registered twice). */
export function registerLiftActions(): () => void {
  return registerActions([CLASSIFY_ON_CLOUD]);
}

registerLiftActions();

type Phase = { kind: 'ask' } | { kind: 'running' } | { kind: 'done'; outcome: LiftOutcome };

function LiftForm({ picks, onClose }: { picks: PhotoPick[]; onClose: () => void }): ReactElement {
  const t = useT();
  const project = workspace.getState().project;
  const clouds = cloudsOf(project?.manifest.layers ?? []);
  const [cloudId, setCloudId] = useState(clouds[0]?.id ?? '');
  const [value, setValue] = useState(LIFT_CLASSES[0] ?? 2);
  const [outlines, setOutlines] = useState<Detection[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void loadDetections(projectId).then(() => {
      if (live) setOutlines(outlinesOn(projectId, picks) ?? []);
    });
    return () => {
      live = false;
    };
  }, [projectId, picks]);
  const cloud = clouds.find((c) => c.id === cloudId) ?? null;
  const masks = outlines
    ? masksFor(outlines, picks, photoSize, (d) =>
        t('cleanup.lift.label', {
          name: d.label ?? d.classId,
          photo: d.source.kind === 'photo' ? d.source.photo : '',
        }),
      )
    : [];
  const run = async () => {
    if (!cloud || masks.length === 0) return;
    setPhase({ kind: 'running' });
    setPhase({ kind: 'done', outcome: await runLift(defaultJobsDeps, cloud, masks, value) });
  };
  const done = phase.kind === 'done' ? phase.outcome : null;
  const footer = done ? (
    <button type="button" className="btn primary" data-testid="lift-close" onClick={onClose}>
      {t('cleanup.lift.close')}
    </button>
  ) : (
    <>
      <button type="button" className="btn ghost" onClick={onClose}>
        {t('cleanup.lift.cancel')}
      </button>
      <button
        type="button"
        className="btn primary"
        data-testid="lift-run"
        disabled={phase.kind === 'running' || !cloud || masks.length === 0}
        onClick={() => void run()}
      >
        {phase.kind === 'running' ? t('cleanup.lift.running') : t('cleanup.lift.run')}
      </button>
    </>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cleanup.lift.title')}
      size="sm"
      testId="lift-dialog"
      hideClose
      dismissable={phase.kind !== 'running'}
      footer={footer}
    >
      {outlines === null ? (
        <p className="help">{t('cleanup.lift.reading')}</p>
      ) : masks.length === 0 ? (
        <p className="help" data-testid="lift-none">
          {t('cleanup.lift.none')}
        </p>
      ) : (
        <p className="help" data-testid="lift-count">
          {t('cleanup.lift.lead', { count: masks.length })}
        </p>
      )}
      {!done && masks.length > 0 && (
        <div className="oc-body">
          {clouds.length > 1 && (
            <label className="oc-field">
              <span>{t('cleanup.lift.cloud')}</span>
              <select
                className="ann-select"
                data-testid="lift-cloud"
                value={cloudId}
                disabled={phase.kind === 'running'}
                onChange={(e) => {
                  setCloudId(e.currentTarget.value);
                }}
              >
                {clouds.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="oc-field">
            <span>{t('cleanup.lift.class')}</span>
            <select
              className="ann-select"
              data-testid="lift-class"
              value={String(value)}
              disabled={phase.kind === 'running'}
              onChange={(e) => {
                setValue(Number(e.currentTarget.value));
              }}
            >
              {LIFT_CLASSES.map((c) => (
                <option key={c} value={String(c)}>
                  {`${String(c)} ${liftClassName(c)}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {done && !done.ok && (
        <p className="prov-err" role="alert" data-testid="lift-error">
          {done.error}
        </p>
      )}
      {done?.ok && (
        <div data-testid="lift-result">
          <p role="status">
            {done.added > 0
              ? t('cleanup.lift.done', {
                  count: done.added,
                  name: liftClassName(value),
                  cloud: cloud?.name ?? '',
                })
              : t('cleanup.lift.nothing')}
          </p>
          {done.skipped.length > 0 && (
            <ul className="help" data-testid="lift-skipped">
              {done.skipped.map((s, i) => (
                <li key={`${s.photo}-${String(i)}`}>
                  {t('cleanup.lift.skipped', { photo: s.photo, reason: s.reason })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The dialog, mounted once (App.tsx), which also reads the add-on list at start; it opens when the action sets photos. */
export function LiftHost(): ReactElement | null {
  const picks = useStore(liftDialog, (s) => s.picks);
  // the photo menu asks synchronously whether Segmentation is installed: read the list at start
  useEffect(() => {
    void addons.getState().ensure();
  }, []);
  if (!picks) return null;
  return (
    <LiftForm
      picks={picks}
      onClose={() => {
        liftDialog.setState({ picks: null });
      }}
    />
  );
}
