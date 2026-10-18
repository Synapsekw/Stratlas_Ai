/**
 * What the antenna inventory keeps going whatever the workbench shows: the project's inventory
 * read in, its boxes and labels in the 3D view (where their survey date is drawn; a pick selects
 * the unit and reveals its row), the camera framing a newly selected unit, the floating card beside
 * the selected box while the 3D view is on screen, and the AI send preview, a modal dialog under
 * <body> so no column, drawer or folded section can clip it or make it inert. The stage mounts it,
 * once.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import { PortalRoot } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import type { Camera } from 'three';
import { useShell } from '../shell';
import { frameOf } from '../survey/measureScene';
import '../survey/telecom.css';
import { flyToLocalBox } from '../workspace/flyToBox';
import { AntennaCard, resetCardDrag } from './AntennaCard';
import { AntennaLabelsControl } from './AntennaLabelsControl';
import { AntennaSendPreview } from './AntennaSendPreview';
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
  loadAntennas,
  revealAntenna,
  sendAiLabels,
  useAntennas,
} from './antennaStore';
import type { Rect } from './cardPlacement';
import { projectToHost } from './screenProjection';

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
  '[data-testid="wb-section-telecom-antennas"] .wb-section-head',
];

/**
 * The screen box of local-frame points, in CSS pixels relative to `host` (the labels' projection).
 * Null when every point is behind the camera or the box lies wholly outside the host.
 */
export function screenRectOf(
  points: readonly Vec3[],
  camera: Camera,
  canvas: HTMLElement,
  host: HTMLElement,
): Rect | null {
  const r = canvas.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    const { x, y, front } = projectToHost(p, camera, r, hr);
    if (!front) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x0 === Infinity) return null;
  if (x1 < 0 || y1 < 0 || x0 > hr.width || y0 > hr.height) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Room for a label's text around its anchor, CSS pixels: sideways, and up and down. */
export const LABEL_PAD_X = 60;
export const LABEL_PAD_Y = 20;

/**
 * The box grown to also cover its labels: the anchors' screen box, padded by the room their text
 * takes, joined to the box. The card is placed beside this, so it does not cover the labels.
 */
export function withLabels(box: Rect, anchors: Rect | null): Rect {
  if (!anchors) return box;
  const x0 = Math.min(box.x, anchors.x - LABEL_PAD_X);
  const y0 = Math.min(box.y, anchors.y - LABEL_PAD_Y);
  const x1 = Math.max(box.x + box.w, anchors.x + anchors.w + LABEL_PAD_X);
  const y1 = Math.max(box.y + box.h, anchors.y + anchors.h + LABEL_PAD_Y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Room left between the card and the selected unit's labels, CSS pixels. */
export const LABEL_GAP = 6;

const union = (a: Rect, b: Rect): Rect => {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return {
    x: x0,
    y: y0,
    w: Math.max(a.x + a.w, b.x + b.w) - x0,
    h: Math.max(a.y + a.h, b.y + b.h) - y0,
  };
};

/**
 * The screen box of the selected unit's labels as drawn (`.antenna-labels .sv-label.sel`), in CSS
 * pixels relative to `host`; null before they are drawn or while none is in view.
 */
export function drawnLabelsRect(host: HTMLElement): Rect | null {
  const hr = host.getBoundingClientRect();
  let out: Rect | null = null;
  for (const el of host.querySelectorAll<HTMLElement>('.antenna-labels .sv-label.sel')) {
    if (el.style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const rect = { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
    out = out ? union(out, rect) : rect;
  }
  return out;
}

/**
 * The box grown to cover its labels as drawn, with `LABEL_GAP` around; before they are drawn,
 * the anchors padded by the room text takes (`withLabels`).
 */
export function withDrawnLabels(box: Rect, drawn: Rect | null, anchors: Rect | null): Rect {
  if (!drawn) return withLabels(box, anchors);
  const u = union(box, drawn);
  return { x: u.x - LABEL_GAP, y: u.y - LABEL_GAP, w: u.w + 2 * LABEL_GAP, h: u.h + 2 * LABEL_GAP };
}

const rounded = (r: Rect | null): Rect | null =>
  r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * The card and its leader line are placed absolutely inside the stage host; a static host would
 * let them escape to the next positioned ancestor, so it is made relative (once; it stays so).
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
  const hasCloud = useAntennaClouds().length > 0;
  const projectId = project?.id ?? null;
  const root = project?.root ?? null;
  const manifest = project?.manifest ?? null;
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  // the labels and the card both read the spots on every frame: computed once per drawn state
  const spotsOf = useMemo(() => (frame ? labelSpotsCache(frame) : null), [frame]);

  // P8: the inventory is read on mount and when the project root changes
  useEffect(() => {
    if (projectId && root && hasCloud) void loadAntennas(projectId, root);
  }, [projectId, root, hasCloud]);

  // a card dragged aside in one project does not stay aside in the next
  const lastProject = useRef(projectId);
  useEffect(() => {
    if (lastProject.current === projectId) return;
    lastProject.current = projectId;
    resetCardDrag();
  }, [projectId]);

  // the boxes and their labels in the 3D view, where their survey date is drawn: a new manifest
  // (a date lined up again) draws them afresh. A newly selected unit (a row, a pick, the walk)
  // brings the camera to it; the same unit again leaves the view where the person put it.
  const drawn = hasCloud && hasFile;
  // told once the labels stand where a frame draws them: the card then measures them
  const afterLabels = useRef(new Set<() => void>());
  useEffect(() => {
    if (!drawn || !stage || !frame || !spotsOf) return;
    const sceneState = (): AntennaSceneState => {
      const a = antennaStore.getState();
      return {
        file: a.file,
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
      onPick: revealAntenna,
    });
    // a pin picks its unit as a box pick does; the selected unit's own pin (none drawn) is a no-op
    const offLabels = attachAntennaLabels(
      stage,
      () => spotsOf(sceneState()),
      (id) => {
        if (antennaStore.getState().selected !== id) revealAntenna(id);
      },
      () => {
        for (const fn of afterLabels.current) fn();
      },
    );
    let last = antennaStore.getState().selected;
    const offFly = antennaStore.subscribe((a) => {
      if (a.selected === last) return;
      last = a.selected;
      const unit = a.file?.units.find((u) => u.id === a.selected);
      if (unit) flyToLocalBox(antennaCorners(unit, frame, antennaShift(a.file, manifest)), 1.0);
    });
    return () => {
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
  // the floating card beside the selected box, only while the 3D view is on screen
  const host = selected !== null ? layerHost : null;
  const [rect, setRect] = useState<Rect | null>(null);
  // before paint, so the card's first frame is already in place
  useLayoutEffect(() => {
    if (!host || !stage || !frame || !spotsOf || !selected) return;
    positionHost(host);
    const canvas = stage.renderer.domElement;
    let last: Rect | null = null;
    const place = () => {
      const a = antennaStore.getState();
      const unit = a.file?.units.find((u) => u.id === selected);
      const shift = antennaShift(a.file, manifest);
      const box = unit
        ? screenRectOf(antennaCorners(unit, frame, shift), stage.camera, canvas, host)
        : null;
      // the selected unit's labels (name, dimensions, angles) are drawn around the box
      const anchors = box
        ? screenRectOf(
            spotsOf({
              file: a.file,
              selected,
              hidden: a.hidden,
              solo: a.solo,
              shift,
              labelMode: a.labelMode,
            })
              .filter((s) => s.selected)
              .map((s) => s.at),
            stage.camera,
            canvas,
            host,
          )
        : null;
      const next = rounded(box && withDrawnLabels(box, drawnLabelsRect(host), anchors));
      // React hears of the box only when it moved by a whole pixel
      if (sameRect(next, last)) return;
      last = next;
      setRect(next);
    };
    place();
    // after the labels are placed in the same frame, so the card measures them where they are
    const listeners = afterLabels.current;
    listeners.add(place);
    return () => {
      listeners.delete(place);
      setRect(null);
    };
  }, [host, stage, frame, manifest, selected, spotsOf]);

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
  if (!shown && !layerHost) return null;
  return (
    <>
      {layerHost && <AntennaLabelsControl host={layerHost} />}
      {host && <AntennaCard stageHost={host} boxRect={rect} />}
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
