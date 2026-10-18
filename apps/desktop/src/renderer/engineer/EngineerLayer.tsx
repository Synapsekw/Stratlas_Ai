import { routeFor, type ModelRoute } from '@aio/ai';
import type { Vec3 } from '@aio/schema';
import { Icon, t, useT, type MessageKey } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { engineerUi, engineeringUiOn, followEngineeringReview, openEngineeringReview } from './ui';
import { useStagePick } from '../builder/pick';
import { modeller, useModeller } from '../modeller';
import { bridge, shell, useShell } from '../shell';
import { EvidencePreview } from './EvidencePreview';
import {
  acceptedCount,
  engineerHost,
  followProject,
  refreshRunHistory,
  restoreRun,
  useHost,
  useRun,
} from './host';
import { SetupDialog } from './SetupDialog';
import { StageList } from './StageList';
import { correctionDraftKey, setCorrectionDraftKey } from './correctionDraft';

/** What a pick in the 3D view is for while the setup waits for it. */
type Picking =
  | { kind: 'region'; done: (r: { centre: [number, number]; radiusM: number } | null) => void }
  | { kind: 'anchor'; done: (p: Vec3 | null) => void }
  | null;

/** Region of interest picked by a click: its centre, with a radius the person then adjusts. */
const DEFAULT_RADIUS_M = 30;

const pickingStore = createStore<{ picking: Picking }>(() => ({ picking: null }));

/** Let a waiting pick go: the setup hears "cancelled" and comes back as it was. */
function cancelPick() {
  const p = pickingStore.getState().picking;
  if (!p) return;
  pickingStore.setState({ picking: null });
  p.done(null);
}

/**
 * While the setup waits for a pick: the click in the 3D view, and a bar that says what to do,
 * with Cancel. Escape cancels too (before the 3D view, so it does not also clear the selection).
 */
function ScenePick() {
  const tt = useT();
  const picking = useStore(pickingStore, (s) => s.picking);
  const armed = picking !== null;
  useStagePick(armed, (hit) => {
    const p = pickingStore.getState().picking;
    if (!p) return;
    pickingStore.setState({ picking: null });
    if (p.kind === 'region')
      p.done(hit ? { centre: [hit.point.x, hit.point.z], radiusM: DEFAULT_RADIUS_M } : null);
    else p.done(hit ? [hit.point.x, hit.point.y, hit.point.z] : null);
  });
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      cancelPick();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [armed]);
  if (!armed) return null;
  return (
    <div className="eng-pickbar" role="status" data-testid="eng-pick-bar">
      <Icon name={picking.kind === 'region' ? 'target' : 'point'} size={14} />
      <span>{tt('eng.pick.say')}</span>
      <button
        type="button"
        className="btn ghost sm"
        data-testid="eng-pick-cancel"
        onClick={cancelPick}
      >
        {tt('eng.pick.cancel')}
      </button>
    </div>
  );
}

function engineerRoute(routes: readonly ModelRoute[]): ModelRoute | null {
  try {
    return routeFor(routes, 'engineer');
  } catch {
    return null;
  }
}

/** A silhouette overlap in words (never a percentage). */
const fitKey = (iou: number): MessageKey =>
  iou >= 0.85 ? 'eng.run.fit.good' : iou >= 0.6 ? 'eng.run.fit.partial' : 'eng.run.fit.poor';

const VIEW_KEYS: Record<string, MessageKey> = {
  north: 'eng.run.view.north',
  east: 'eng.run.view.east',
  south: 'eng.run.view.south',
  west: 'eng.run.view.west',
  top: 'eng.run.view.top',
};

/** Show or hide layers in the 3D view (the run's sources, its draft). */
function setLayersVisible(ids: readonly string[], visible: boolean) {
  for (const id of ids) workspace.getState().setLayerVisible(id, visible);
}

/**
 * The run of an engineering model, beside the 3D view: its stages with Cancel and Retry, why it
 * stopped, a send waiting for consent, identity conflicts with the photos to drop, the source and
 * draft shown together or apart, how the draft's outline fits the scan, and Accept (only once a
 * component is accepted in the review).
 */
function SavedRuns() {
  const t = useT();
  const history = useHost((s) => s.history);
  const busy = useRun((s) => s.busy, false);
  const current = useRun((s) => s.run?.id, undefined);
  if (!history.length) return null;
  return (
    <label className="eng-history">
      {t('eng.run.saved')}
      <select
        data-testid="eng-saved-runs"
        disabled={busy}
        value={current ?? ''}
        onChange={(e) => {
          if (e.target.value) void restoreRun(e.target.value);
        }}
      >
        <option value="">{t('eng.run.chooseSaved')}</option>
        {history.map((r) => (
          <option key={r.id} value={r.id}>
            {new Date(r.createdAt).toLocaleString()} · {r.modelId}
          </option>
        ))}
      </select>
    </label>
  );
}

function RunPanel() {
  const tt = useT();
  const store = useHost((s) => s.store);
  const hostError = useHost((s) => s.error);
  const run = useRun((s) => s.run, null);
  const busy = useRun((s) => s.busy, false);
  const error = useRun((s) => s.error, null);
  const notice = useRun((s) => s.notice, null);
  const conflicts = useRun((s) => s.conflicts, []);
  const model = useRun((s) => s.model, null);
  const draftLayer = useRun((s) => s.draftLayer, null);
  const layer = useRun((s) => s.layer, null);
  const silhouette = useRun((s) => s.silhouette, null);
  const hidden = useWorkspace((s) => s.hidden);
  if (!store || !run) return null;
  const st = store.getState();
  const sources = [...run.setup.sources.clouds, ...run.setup.sources.meshes].map((s) => s.layer);
  const sourceShown = sources.some((id) => !hidden[id]);
  const draftShown = draftLayer !== null && !hidden[draftLayer];
  const accepted = acceptedCount(model);
  const reviewReady = run.stages.validate?.status === 'done' || model !== null;
  return (
    <section className="b-align eng-run" aria-label={tt('eng.run.title')} data-testid="eng-run">
      <header role="none">
        <Icon name="box" size={14} />
        <b>{tt('eng.run.title')}</b>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            engineerUi.getState().hide();
          }}
        >
          {tt('eng.run.close')}
        </button>
      </header>
      <div className="scroll">
        <SavedRuns />
        <div className="sec">
          <StageList
            stages={run.stages}
            busy={busy}
            error={error}
            onCancel={() => void st.cancel()}
            onRetry={() => void st.retry()}
          />
          {error && (
            <p className="eng-bad" role="alert" data-testid="eng-run-error">
              {error}
            </p>
          )}
          {notice && (
            <p className="say" role="status" data-testid="eng-run-notice">
              {notice}
            </p>
          )}
        </div>
        {conflicts.length > 0 && (
          <div className="sec" data-testid="eng-conflicts">
            {conflicts.map((c, i) => (
              <div className="eng-conflict" role="alert" key={i}>
                <span>{tt('eng.run.conflict', { reason: c.reason })}</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void st.dropImages(c.imageIds)}
                >
                  {tt('eng.run.dropPhotos', { count: c.imageIds.length })}
                </button>
              </div>
            ))}
          </div>
        )}
        {(sources.length > 0 || draftLayer) && (
          <div className="sec" role="group" aria-label={tt('eng.run.views')}>
            {sources.length > 0 && (
              <label className="eng-choice">
                <input
                  type="checkbox"
                  checked={sourceShown}
                  data-testid="eng-show-source"
                  onChange={(e) => {
                    setLayersVisible(sources, e.target.checked);
                  }}
                />
                <span>{tt('eng.run.showSource')}</span>
              </label>
            )}
            {draftLayer && (
              <label className="eng-choice">
                <input
                  type="checkbox"
                  checked={draftShown}
                  data-testid="eng-show-draft"
                  onChange={(e) => {
                    setLayersVisible([draftLayer], e.target.checked);
                  }}
                />
                <span>{tt('eng.run.showDraft')}</span>
              </label>
            )}
            {silhouette && Object.keys(silhouette).length > 0 && (
              <>
                <span className="faint">{tt('eng.run.overlap')}</span>
                <ul className="eng-scores" data-testid="eng-overlap">
                  {Object.entries(silhouette).map(([view, score]) => (
                    <li key={view}>
                      {VIEW_KEYS[view] ? tt(VIEW_KEYS[view]) : view}: {tt(fitKey(score))}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {reviewReady && (
          <div className="sec">
            {layer && (
              <p className="say" role="status">
                {tt('eng.run.accepted')}
              </p>
            )}
            {accepted === 0 && (
              <p className="say" data-testid="eng-accept-needs">
                {tt('eng.run.acceptNeeds')}
              </p>
            )}
            {hostError && (
              <p className="eng-bad" role="alert">
                {hostError}
              </p>
            )}
            <div className="acts">
              <button
                type="button"
                className="btn primary"
                data-testid="eng-review"
                disabled={busy || !(draftLayer ?? layer) || !model}
                onClick={() => {
                  modeller.getState().hide();
                  shell.getState().go('scene');
                  openEngineeringReview();
                }}
              >
                {tt('eng.run.review')}
              </button>
            </div>
          </div>
        )}
        {!busy && (
          <div className="sec">
            <button
              type="button"
              className="btn ghost sm"
              data-testid="eng-new-run"
              onClick={() => {
                void refreshRunHistory();
                store.setState({ run: null, model: null, error: null, notice: null });
              }}
            >
              {tt('eng.run.new')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** A send waiting for the person: what would leave the workstation, and the choice. */
function PendingSend() {
  const store = useHost((s) => s.store);
  const preview = useRun((s) => s.preview, null);
  const budgetUsd = useRun((s) => s.run?.setup.budgetUsd, undefined);
  if (!store || !preview) return null;
  const st = store.getState();
  return (
    <EvidencePreview
      content={preview.content}
      budgetUsd={budgetUsd}
      route={preview.route}
      estimateUsd={preview.estimateUsd}
      flags={preview.flags}
      onAllowProject={(kind) => void st.allowProject(kind)}
      onSendOnce={(o) => {
        st.sendPreview(o);
      }}
      onCancel={() => {
        st.declinePreview();
      }}
    />
  );
}

/**
 * The engineering model's mount point (as ModellerLayer): follows the open project's run, the
 * setup dialog, the run panel and a send waiting for consent. Renders nothing while
 * `ENGINEERING_MODEL_UI` is off.
 */
export function EngineerLayer() {
  useEffect(followEngineeringReview, []);
  const on = engineeringUiOn();
  useEffect(() => (on ? followProject() : undefined), [on]);
  // a pick waits only while its setup is open and its project is the open one
  useEffect(() => {
    const offUi = engineerUi.subscribe((s, prev) => {
      if (prev.open && !s.open) cancelPick();
    });
    const offProject = workspace.subscribe((s, prev) => {
      if (s.project?.id !== prev.project?.id) cancelPick();
    });
    return () => {
      offUi();
      offProject();
      cancelPick();
    };
  }, []);
  const open = useStore(engineerUi, (s) => s.open);
  const review = useStore(engineerUi, (s) => s.review);
  const preselect = useStore(engineerUi, (s) => s.preselect);
  const picking = useStore(pickingStore, (s) => s.picking !== null);
  const layers = useWorkspace((s) => s.project?.manifest.layers ?? null);
  const routes = useShell((s) => s.settings.routes);
  const online = useShell((s) => s.settings.offlineOnly !== true);
  const store = useHost((s) => s.store);
  const run = useRun((s) => s.run, null);
  const evidence = useRun((s) => s.evidence, null);
  const builderOpen = useModeller((s) => s.open);
  // A tab can be closed while its run changes. Clear its ephemeral draft even while unmounted.
  useEffect(() => {
    const sync = () => {
      setCorrectionDraftKey(
        correctionDraftKey(workspace.getState().project?.id, store?.getState().run?.id),
      );
    };
    sync();
    return store?.subscribe((next, prev) => {
      if (next.run?.id !== prev.run?.id) sync();
    });
  }, [store]);
  useEffect(
    () =>
      store?.subscribe((next, prev) => {
        if (
          prev.busy &&
          !next.busy &&
          !next.error &&
          next.draftLayer &&
          next.run?.stages.review?.status === 'done' &&
          engineerUi.getState().open
        ) {
          modeller.getState().hide();
          shell.getState().go('scene');
          openEngineeringReview(true);
        }
      }),
    [store],
  );
  if (!on || !layers || !store) return null;
  const hint = evidence?.familyHints ?? null;
  return (
    <>
      <ScenePick />
      <PendingSend />
      {/* the Model builder takes that place while it is open (the review); the run comes back after */}
      {open && run && !builderOpen && !review && <RunPanel />}
      {open && !run && (
        <SetupDialog
          savedRuns={<SavedRuns />}
          hidden={picking}
          layers={layers}
          route={engineerRoute(routes)}
          online={online}
          familyHint={hint ? { suggested: hint.suggested, reasons: hint.reasons } : null}
          initial={preselect}
          run={{
            start: (setup) => {
              engineerHost.setState({ error: null });
              return store.getState().start(setup);
            },
          }}
          onPickPhotos={async () => {
            const r = await bridge.call('dialog:openFiles', {
              title: t('eng.setup.photoPicker'),
              filters: [
                {
                  name: t('eng.setup.photoFilter'),
                  extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'],
                },
              ],
              multi: true,
            });
            return r.ok ? r.value.paths : [];
          }}
          onPickSupplement={async (kind) => {
            const r = await bridge.call('dialog:openFiles', {
              title: t(kind === 'drawings' ? 'eng.setup.addDrawings' : 'eng.setup.addCameras'),
              filters: [
                {
                  name: kind === 'drawings' ? 'DXF' : 'BlocksExchange XML',
                  extensions: [kind === 'drawings' ? 'dxf' : 'xml'],
                },
              ],
              multi: kind === 'drawings',
            });
            return r.ok ? r.value.paths : [];
          }}
          onPickRegion={() =>
            new Promise((done) => {
              pickingStore.setState({ picking: { kind: 'region', done } });
            })
          }
          onPickAnchor={() =>
            new Promise((done) => {
              pickingStore.setState({ picking: { kind: 'anchor', done } });
            })
          }
          onOpenSettings={() => {
            engineerUi.getState().hide();
            shell.getState().openSettingsPage('ai');
          }}
          onPreview={(setup) => {
            // the preview of a send needs the measured evidence: start measuring; the send waits
            // for the person (nothing leaves before the preview is confirmed)
            void store.getState().start(setup);
          }}
          onClose={() => {
            engineerUi.getState().hide();
          }}
        />
      )}
    </>
  );
}
