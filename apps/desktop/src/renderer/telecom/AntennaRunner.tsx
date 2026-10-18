/**
 * What the antenna inventory keeps going whatever the workbench shows: the project's inventory
 * read in, its boxes and labels in the 3D view (where their survey date is drawn; a pick selects
 * the unit and reveals its row), the camera framing a newly selected unit, the floating card beside
 * the selected box while the 3D view is on screen, and the AI send preview, a modal dialog under
 * <body> so no column, drawer or folded section can clip it or make it inert. The stage mounts it,
 * once.
 */
import { getActiveStage, onActiveScene, type EngineStage } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import { PortalRoot } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { Vector3, type Camera } from 'three';
import { useShell } from '../shell';
import { frameOf } from '../survey/measureScene';
import '../survey/telecom.css';
import { flyToLocalBox } from '../workspace/flyToBox';
import { AntennaCard, resetCardDrag } from './AntennaCard';
import { AntennaSendPreview } from './AntennaSendPreview';
import { attachAntennaLabels } from './antennaLabels';
import { antennaCorners } from './antennaMeasure';
import {
  antennaLabelSpots,
  antennaShift,
  attachAntennaLayer,
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

const tmp = new Vector3();

/**
 * The screen box of local-frame points, in CSS pixels relative to `host` (the math of the labels'
 * placement). Null when every point is behind the camera or the box lies wholly outside the host.
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
    tmp.set(p[0], p[1], p[2]).project(camera);
    if (tmp.z > 1) continue;
    const x = r.left + ((tmp.x + 1) / 2) * r.width - hr.left;
    const y = r.top + ((1 - tmp.y) / 2) * r.height - hr.top;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x0 === Infinity) return null;
  if (x1 < 0 || y1 < 0 || x0 > hr.width || y0 > hr.height) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const rounded = (r: Rect | null): Rect | null =>
  r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** The element the card is drawn in: the canvas's parent, made a positioned box if it was not. */
function cardHost(stage: EngineStage): HTMLElement | null {
  const host = stage.renderer.domElement.parentElement;
  // the card and its leader line are placed absolutely inside it; a static host would let them
  // escape to the next positioned ancestor, so it is made relative (once; it stays so)
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  return host;
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
  useEffect(() => {
    if (!drawn || !stage || !frame) return;
    const sceneState = (): AntennaSceneState => {
      const a = antennaStore.getState();
      return {
        file: a.file,
        selected: a.selected,
        hidden: a.hidden,
        solo: a.solo,
        shift: antennaShift(a.file, manifest),
      };
    };
    const offLayer = attachAntennaLayer(stage, frame, {
      getState: sceneState,
      subscribe: (cb) => antennaStore.subscribe(cb),
      onPick: revealAntenna,
    });
    const offLabels = attachAntennaLabels(stage, frame, () =>
      antennaLabelSpots(sceneState(), frame),
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
  }, [drawn, stage, frame, manifest]);

  // the floating card beside the selected box, only while the 3D view is on screen
  const showCard = drawn && stage !== null && frame !== null && selected !== null && onScene;
  const cardStage = showCard ? stage : null;
  const host = useMemo(() => (cardStage ? cardHost(cardStage) : null), [cardStage]);
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!host || !stage || !frame || !selected) return;
    const canvas = stage.renderer.domElement;
    let last: Rect | null = null;
    const place = () => {
      const a = antennaStore.getState();
      const unit = a.file?.units.find((u) => u.id === selected);
      const next = rounded(
        unit
          ? screenRectOf(
              antennaCorners(unit, frame, antennaShift(a.file, manifest)),
              stage.camera,
              canvas,
              host,
            )
          : null,
      );
      // React hears of the box only when it moved by a whole pixel
      if (sameRect(next, last)) return;
      last = next;
      setRect(next);
    };
    place();
    const off = stage.onFrame(place);
    return () => {
      off();
      setRect(null);
    };
  }, [host, stage, frame, manifest, selected]);

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
  if (!shown && !host) return null;
  return (
    <>
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
