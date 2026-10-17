/**
 * What the antenna inventory keeps going whatever the workbench shows: the project's inventory
 * read in, its boxes in the 3D view (where their survey date is drawn; a pick selects the unit and
 * reveals its row), and the AI send preview, a modal dialog under <body> so no column, drawer or
 * folded section can clip it or make it inert. Mount it exactly once.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import { PortalRoot } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { useShell } from '../shell';
import { frameOf } from '../survey/measureScene';
import '../survey/telecom.css';
import { AntennaSendPreview } from './AntennaSendPreview';
import { antennaShift, attachAntennaLayer } from './antennaScene';
import {
  antennaStore,
  cancelAiLabels,
  loadAntennas,
  revealAntenna,
  sendAiLabels,
  useAntennas,
} from './antennaStore';

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

export function AntennaRunner(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const hasFile = useAntennas((a) => a.file !== null);
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

  // the boxes in the 3D view, where their survey date is drawn: a new manifest (a date lined up
  // again) draws them afresh
  const drawn = hasCloud && hasFile;
  useEffect(() => {
    if (!drawn || !stage || !frame) return;
    return attachAntennaLayer(stage, frame, {
      getState: () => {
        const a = antennaStore.getState();
        return {
          file: a.file,
          selected: a.selected,
          hidden: a.hidden,
          shift: antennaShift(a.file, manifest),
        };
      },
      subscribe: (cb) => antennaStore.subscribe(cb),
      onPick: revealAntenna,
    });
  }, [drawn, stage, frame, manifest]);

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
  if (!shown) return null;
  return (
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
  );
}
