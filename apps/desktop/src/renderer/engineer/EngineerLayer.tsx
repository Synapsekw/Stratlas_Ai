import { routeFor, type ModelRoute } from '@aio/ai';
import type { EngineerRun, EngineerSetup, EvidencePack, Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useStagePick } from '../builder/pick';
import { bridge, shell, useShell } from '../shell';
import { ENGINEERING_MODEL_UI } from './flags';
import { SetupDialog } from './SetupDialog';
import { StageList } from './StageList';

/** Whether the setup is open; Create engineering model opens it (once the UI is on). */
export const engineerUi = createStore<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => {
    set({ open: true });
  },
  hide: () => {
    set({ open: false });
  },
}));

/** The run store's controls and state as the setup and the stage list use them (Task 35). */
export interface EngineerRunControls {
  start(setup: EngineerSetup): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
}

/** The flag as a plain boolean (the constant is fixed per build). */
const uiOn: boolean = ENGINEERING_MODEL_UI;

/** What a pick in the 3D view is for while the setup waits for it. */
type Picking =
  | { kind: 'region'; done: (r: { centre: [number, number]; radiusM: number } | null) => void }
  | { kind: 'anchor'; done: (p: Vec3 | null) => void }
  | null;

/** Region of interest picked by a click: its centre, with a radius the person then adjusts. */
const DEFAULT_RADIUS_M = 30;

const pickingStore = createStore<{ picking: Picking }>(() => ({ picking: null }));

function ScenePick() {
  const picking = useStore(pickingStore, (s) => s.picking);
  useStagePick(picking !== null, (hit) => {
    const p = pickingStore.getState().picking;
    if (!p) return;
    pickingStore.setState({ picking: null });
    if (p.kind === 'region')
      p.done(hit ? { centre: [hit.point.x, hit.point.z], radiusM: DEFAULT_RADIUS_M } : null);
    else p.done(hit ? [hit.point.x, hit.point.y, hit.point.z] : null);
  });
  return null;
}

function engineerRoute(routes: readonly ModelRoute[]): ModelRoute | null {
  try {
    return routeFor(routes, 'engineer');
  } catch {
    return null;
  }
}

/**
 * The engineering model's mount point (as ModellerLayer): the setup dialog and, during a run, its
 * stages. Renders nothing while `ENGINEERING_MODEL_UI` is off. The run store (Task 35) is handed
 * in as `controls` and `run`; the data-sharing preview opens through `onPreview`.
 */
export function EngineerLayer({
  controls,
  run,
  evidence,
  onPreview,
}: {
  controls?: EngineerRunControls | undefined;
  run?: EngineerRun | null | undefined;
  evidence?: EvidencePack | null | undefined;
  onPreview?: ((setup: EngineerSetup) => void) | undefined;
}) {
  const open = useStore(engineerUi, (s) => s.open);
  const picking = useStore(pickingStore, (s) => s.picking !== null);
  const layers = useWorkspace((s) => s.project?.manifest.layers ?? null);
  const routes = useShell((s) => s.settings.routes);
  const online = useShell((s) => s.settings.offlineOnly !== true);
  if (!uiOn || !layers || !controls) return null;
  const hint = evidence?.familyHints ?? null;
  return (
    <>
      <ScenePick />
      {open && !picking && !run && (
        <SetupDialog
          layers={layers}
          route={engineerRoute(routes)}
          online={online}
          familyHint={hint ? { suggested: hint.suggested, reasons: hint.reasons } : null}
          run={controls}
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
          onPreview={(setup) => onPreview?.(setup)}
          onClose={() => {
            engineerUi.getState().hide();
          }}
        />
      )}
      {open && run && (
        <section className="b-align eng-run" aria-label="Engineering model run">
          <StageList
            stages={run.stages}
            onCancel={() => void controls.cancel()}
            onRetry={() => void controls.retry()}
          />
        </section>
      )}
    </>
  );
}
