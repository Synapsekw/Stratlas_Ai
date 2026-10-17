/**
 * The antenna inventory as a section of the Measure workbench: the run's warnings, the units by
 * kind, the selected unit's details and the AI send preview. While it is mounted the boxes are
 * drawn in the 3D view, where their survey date is drawn, and a pick in the scene selects the row.
 * The "Detect antennas" button lives in the Telecom family (`survey/DetectAntennas.tsx`), the CSV
 * export next to "Export survey data" (`AntennaCsvTool.tsx`).
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import type { IpcResponse } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { openPhoto } from '../builder/photoOpen';
import { bridge, useShell } from '../shell';
import { frameOf } from '../survey/measureScene';
import '../survey/telecom.css';
import { Section } from '../workspace/workbench/Section';
import { sectionStore, useSections } from '../workspace/workbench/sectionState';
import { AntennaDetails } from './AntennaDetails';
import { AntennaInventory } from './AntennaInventory';
import { AntennaSendPreview } from './AntennaSendPreview';
import { antennaShift, attachAntennaLayer } from './antennaScene';
import {
  antennaStore,
  applyAiLabels,
  getAiLabelPref,
  loadAntennas,
  patchUnitUser,
  selectAntenna,
  setUnitStatus,
  toggleAntennaHidden,
  useAntennas,
} from './antennaStore';

const BENCH = 'measure';
const SECTION = 'telecom-antennas';

type Preview = Extract<IpcResponse<'ai:antennaLabelPreview'>, { ok: true }>;

/** Unwrap a bridge answer to its value, or the text of why not. */
function unwrap<T extends { ok: boolean }>(
  r: { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value: Extract<T, { ok: true }> } | { ok: false; error: string } {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: (r.value as { error?: string }).error ?? '' };
  return { ok: true, value: r.value as Extract<T, { ok: true }> };
}

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

export function AntennaSection(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const s = useAntennas((a) => a);
  const sections = useSections(BENCH);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ value: Preview; unitIds: string[] } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const picked = useRef(false);

  const projectId = project?.id ?? null;
  const root = project?.root ?? null;
  const manifest = project?.manifest ?? null;
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  const hasCloud = useAntennaClouds().length > 0;

  // P8: the inventory is read on mount and when the project root changes
  useEffect(() => {
    if (projectId && root && hasCloud) void loadAntennas(projectId, root);
  }, [projectId, root, hasCloud]);

  const [seenProject, setSeenProject] = useState(projectId);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setNote(null);
    setPreview(null);
  }

  const file = s.file;
  const shown = hasCloud && (file !== null || s.running);

  // the boxes in the 3D view while the section is shown, where their survey date is drawn: a new
  // manifest (a date lined up again) draws them afresh
  useEffect(() => {
    if (!shown || !stage || !frame) return;
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
      onPick: (id) => {
        picked.current = true;
        selectAntenna(id);
      },
    });
  }, [shown, stage, frame, manifest]);

  // a pick in the scene opens the section and brings its row into view
  const open = sections.isOpen(SECTION, true);
  useEffect(() => {
    if (!picked.current || !s.selected) return;
    if (!open) {
      sectionStore.getState().toggle(BENCH, SECTION, false);
      return; // the row scrolls into view once the section has opened
    }
    picked.current = false;
    const row = panel.current?.querySelector('[role="treeitem"][aria-selected="true"]');
    (row as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [s.selected, open]);

  // a run that finished well: label with AI once the new file is in
  useEffect(() => {
    if (!projectId) return;
    let startRun: string | null = null;
    let awaiting = false;
    return antennaStore.subscribe((next, prev) => {
      if (next.running && !prev.running) {
        startRun = next.file?.run.id ?? prev.file?.run.id ?? null;
        awaiting = false;
      }
      if (prev.running && !next.running && !next.needsHint && !next.message) awaiting = true;
      const done = next.file;
      if (!awaiting || next.status !== 'ready' || !done || done.run.id === startRun) return;
      awaiting = false;
      if (!getAiLabelPref(projectId)) return;
      const unitIds = done.units
        .filter((u) => u.kindBasis !== 'user' && u.status !== 'rejected' && !u.notFoundInLatest)
        .map((u) => u.id)
        .slice(0, 200);
      if (unitIds.length === 0) return;
      void bridge.call('ai:antennaLabelPreview', { projectId, unitIds }).then((r) => {
        const v = unwrap(r);
        if (v.ok) setPreview({ value: v.value, unitIds });
        else setNote(t('telecom.antennas.ai.skipped', { reason: v.error }));
      });
    });
  }, [projectId]);

  if (!project || !projectId || !shown) return null;

  const selected = file?.units.find((u) => u.id === s.selected);
  const aiProvider = selected?.ai?.provider;
  const listed = file?.units.filter((u) => u.status !== 'rejected').length;

  const send = (photos: boolean) => {
    const p = preview;
    setPreview(null);
    if (!p) return;
    const runId = `ai-${String(Date.now())}`;
    void bridge
      .call('ai:labelAntennas', {
        runId,
        projectId,
        unitIds: p.unitIds,
        token: p.value.token,
        ...(photos ? { photos: true } : {}),
      })
      .then(async (r) => {
        const v = unwrap(r);
        if (v.ok) await applyAiLabels(v.value, runId, projectId);
        else setNote(t('telecom.antennas.ai.skipped', { reason: v.error }));
      });
  };

  return (
    <>
      <Section
        bench={BENCH}
        id={SECTION}
        title={t('telecom.antennas.title')}
        count={listed}
        defaultOpen
      >
        <div
          ref={panel}
          className="telecom-antennas"
          role="region"
          data-testid="antenna-panel"
          aria-label={t('telecom.antennas.title')}
        >
          {note && (
            <p className="telecom-help" role="status">
              {note}
            </p>
          )}
          {file && file.run.warnings.length > 0 && (
            <div>
              <b>{t('telecom.antennas.warnings')}</b>
              <ul>
                {file.run.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <AntennaInventory
            file={file}
            selected={s.selected}
            hidden={s.hidden}
            readOnly={s.readOnly}
            onSelect={selectAntenna}
            onToggleVisible={toggleAntennaHidden}
            onSetStatus={(id, status) => {
              void setUnitStatus(id, status);
            }}
            onOpenDetails={selectAntenna}
          />
          {selected && (
            <AntennaDetails
              key={selected.id}
              unit={selected}
              projectId={projectId}
              readOnly={s.readOnly}
              {...(aiProvider !== undefined ? { aiProvider } : {})}
              onSetStatus={(status) => {
                void setUnitStatus(selected.id, status);
              }}
              onPatchUser={(fields) => {
                void patchUnitUser(selected.id, fields);
              }}
              onOpenPhoto={openPhoto}
            />
          )}
        </div>
      </Section>
      {/* a dialog: outside the section, which a fold makes inert */}
      {preview && (
        <AntennaSendPreview
          preview={preview.value}
          projectId={projectId}
          onSend={send}
          onCancel={() => {
            setPreview(null);
          }}
        />
      )}
    </>
  );
}
