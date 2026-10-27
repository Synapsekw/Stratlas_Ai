/**
 * What the antenna inventory keeps going whatever the workbench shows: the project's inventory
 * read in, its boxes and labels in the 3D view (where their survey date is drawn; a pick selects
 * the unit and shows its row in the Project tab, a right-click opens the antenna menu), the
 * camera framing a newly selected unit or a fly request (the list's Fly to), the review keys while
 * a unit is selected, the delete confirmation, and the AI send preview, a modal dialog under <body>
 * so no column, drawer or folded section can clip it or make it inert. The unit's details live in
 * the Project list, not on the stage. The stage mounts it, once.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import { PortalRoot } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { useShell } from '../shell';
import { frameOf } from '../survey/measureScene';
import '../survey/telecom.css';
import { flyToLocalBox } from '../workspace/flyToBox';
import { followAntennaPick } from '../workspace/workbench/project/antennaFollow';
import { AntennaDeleteDialog } from './AntennaDeleteDialog';
import { AntennaLabelsControl } from './AntennaLabelsControl';
import { AntennaMenu } from './AntennaMenu';
import { AntennaSendPreview } from './AntennaSendPreview';
import { attachAntennaHandles } from './antennaHandles';
import { attachAntennaLabels } from './antennaLabels';
import { antennaCorners } from './antennaMeasure';
import {
  antennaShift,
  attachAntennaLayer,
  labelSpotsCache,
  type AntennaSceneState,
} from './antennaScene';
import {
  antennaStore,
  cancelAiLabels,
  closeAntennaMenu,
  drawnFile,
  loadAntennas,
  openAntennaMenu,
  resetAntennas,
  sendAiLabels,
  useAntennas,
} from './antennaStore';
import { useAntennaKeys } from './useAntennaKeys';

/** The point cloud layers of the open project, none in a package (read only, no pipelines). */
export function useAntennaClouds() {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const pkg = useShell((s) => s.pkg);
  const clouds = useMemo(
    () => (manifest?.layers ?? []).filter((l) => l.kind === 'pointcloud'),
    [manifest],
  );
  return pkg === null ? clouds : [];
}

/** Where focus goes when the preview closes and the element it came from is gone. */
const FOCUS_FALLBACK = [
  '[data-testid="detect-antennas"]',
  '[data-testid="wb-section-project-antennas"] .wb-section-head',
];

/**
 * The Labels control is placed absolutely inside the stage host; a static host would let it
 * escape to the next positioned ancestor, so it is made relative (once; it stays so).
 */
function positionHost(host: HTMLElement): void {
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
}

export function AntennaRunner(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const hasFile = useAntennas((a) => a.file !== null);
  const selected = useAntennas((a) => a.selected);
  // the 3D view is on screen: the scene screen, in a stage mode that shows it
  const onScene = useShell((s) => s.screen === 'scene' && s.stageMode !== 'map');
  const preview = useAntennas((a) => a.aiPreview);
  const menu = useAntennas((a) => a.menu);
  const clouds = useAntennaClouds();
  const hasCloud = clouds.length > 0;
  const cloudLayer = useAntennas((a) => a.cloudLayer);
  // the layer a box drag is measured on, as the Flag antenna tool picks it: the one chosen for
  // detection, else the newest visible cloud
  const measureLayer = useRef<string | null>(null);
  const layerNow = cloudLayer ?? clouds.filter((l) => l.visible).at(-1)?.id ?? null;
  useEffect(() => {
    measureLayer.current = layerNow;
  }, [layerNow]);
  const projectId = project?.id ?? null;
  const root = project?.root ?? null;
  const manifest = project?.manifest ?? null;
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  // the labels read the spots on every frame: computed once per drawn state
  const spotsOf = useMemo(() => (frame ? labelSpotsCache(frame) : null), [frame]);

  // P8: the inventory is read on mount and when the project root changes; a project it is not read
  // for (no cloud, a package, none open) drops the last project's
  useEffect(() => {
    if (projectId && root && hasCloud) void loadAntennas(projectId, root);
    else if (antennaStore.getState().projectId !== projectId) resetAntennas();
  }, [projectId, root, hasCloud]);

  // the boxes and their labels in the 3D view, where their survey date is drawn: a new manifest
  // (a date lined up again) draws them afresh. A newly selected unit (a row, a pick, the walk)
  // brings the camera to it; the same unit again leaves the view where the person put it.
  const drawn = hasCloud && hasFile;
  useEffect(() => {
    if (!drawn || !stage || !frame || !spotsOf) return;
    // the unit being dragged or measured is drawn in its dragged box; the same file object while
    // nothing changes, so the drawn state is not rebuilt on every frame
    let drawnOf: { file: unknown; edit: unknown; out: ReturnType<typeof drawnFile> } | null = null;
    const sceneFile = () => {
      const a = antennaStore.getState();
      if (drawnOf?.file !== a.file || drawnOf.edit !== a.boxEdit)
        drawnOf = { file: a.file, edit: a.boxEdit, out: drawnFile(a.file, a.boxEdit) };
      return drawnOf.out;
    };
    const sceneState = (): AntennaSceneState => {
      const a = antennaStore.getState();
      return {
        file: sceneFile(),
        selected: a.selected,
        hidden: a.hidden,
        solo: a.solo,
        shift: antennaShift(a.file, manifest),
        labelMode: a.labelMode,
      };
    };
    const offLayer = attachAntennaLayer(stage, frame, {
      getState: sceneState,
      subscribe: (cb) => antennaStore.subscribe(cb),
      onPick: followAntennaPick,
      onMenu: openAntennaMenu,
    });
    // a pin picks its unit as a box pick does; the selected unit's own pin (none drawn) is a no-op
    // while a face is dragged its chip carries the value: the W, H and D labels step aside
    const offLabels = attachAntennaLabels(
      stage,
      () => {
        const spots = spotsOf(sceneState());
        return antennaStore.getState().boxEdit?.phase === 'drag'
          ? spots.filter((sp) => sp.kind !== 'dim')
          : spots;
      },
      (id) => {
        if (antennaStore.getState().selected !== id) followAntennaPick(id);
      },
    );
    // the drag handles on the selected unit's box
    const offHandles = attachAntennaHandles(stage, frame, {
      getShift: () => antennaShift(antennaStore.getState().file, manifest),
      getLayer: () => measureLayer.current,
    });
    let last = antennaStore.getState().selected;
    let lastFly = antennaStore.getState().flyRequest?.seq ?? 0;
    const offFly = antennaStore.subscribe((a) => {
      if (a.selected !== last) {
        last = a.selected;
        const unit = a.file?.units.find((u) => u.id === a.selected);
        if (unit) flyToLocalBox(antennaCorners(unit, frame, antennaShift(a.file, manifest)), 1.0);
      }
      // the list's Fly to: the camera frames every unit of the request together
      const req = a.flyRequest;
      if (req && req.seq !== lastFly) {
        lastFly = req.seq;
        const shift = antennaShift(a.file, manifest);
        const corners = (a.file?.units ?? [])
          .filter((u) => req.ids.includes(u.id))
          .flatMap((u) => antennaCorners(u, frame, shift));
        if (corners.length > 0) flyToLocalBox(corners, 1.0);
      }
    });
    return () => {
      offHandles();
      offFly();
      offLabels();
      offLayer();
    };
  }, [drawn, stage, frame, manifest, spotsOf]);

  // the Labels control while the antennas are drawn in a 3D view on screen
  const showLayer = drawn && stage !== null && frame !== null && onScene;
  const layerHost = showLayer ? (stage.renderer.domElement.parentElement ?? null) : null;
  useLayoutEffect(() => {
    if (layerHost) positionHost(layerHost);
  }, [layerHost]);
  // the review keys (A, R, arrows, Esc, Delete) while a unit is selected
  useAntennaKeys(selected !== null);

  // the dialog gives focus back where it came from; when that element went away meanwhile (a
  // drawer slid out), it goes to the button or the inventory instead of being lost
  const wasOpen = useRef(false);
  useEffect(() => {
    if (preview) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const id = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      for (const sel of FOCUS_FALLBACK) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && !el.closest('[inert]')) {
          el.focus();
          return;
        }
      }
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [preview]);

  // a preview for another project (switched meanwhile) is not shown
  const shown = preview?.projectId === projectId ? preview : null;
  return (
    <>
      {layerHost && <AntennaLabelsControl host={layerHost} />}
      <AntennaDeleteDialog />
      <AntennaMenu at={menu} onClose={closeAntennaMenu} />
      {shown && (
        <PortalRoot opener={null} className="antenna-send-layer">
          <AntennaSendPreview
            preview={shown.value}
            projectId={shown.projectId}
            onSend={(photos) => {
              void sendAiLabels(photos);
            }}
            onCancel={cancelAiLabels}
          />
        </PortalRoot>
      )}
    </>
  );
}
