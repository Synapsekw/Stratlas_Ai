/**
 * Temporary entry for antenna detection: the "Detect antennas" button with its options, and a
 * plain panel with the inventory, the selected unit, the AI send preview and the CSV export. The
 * workbench rework moves all of it; progress shows in the jobs chip, not here.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import type { IpcResponse } from '@aio/schema';
import { Button, IconButton, Popover, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { openPhoto } from '../builder/photoOpen';
import { bridge, useShell } from '../shell';
import { AntennaDetails } from '../telecom/AntennaDetails';
import { AntennaInventory } from '../telecom/AntennaInventory';
import { AntennaSendPreview } from '../telecom/AntennaSendPreview';
import { antennasToCsv } from '../telecom/antennaCsv';
import { armTowerPick, attachAntennaLayer } from '../telecom/antennaScene';
import {
  antennaStore,
  applyAiLabels,
  cancelHint,
  getAiLabelPref,
  loadAntennas,
  patchUnitUser,
  runDetection,
  selectAntenna,
  setAiLabelPref,
  setCloudLayer,
  setUnitStatus,
  toggleAntennaHidden,
  useAntennas,
} from '../telecom/antennaStore';
import { frameOf } from './measureScene';

type Preview = Extract<IpcResponse<'ai:antennaLabelPreview'>, { ok: true }>;

/** Unwrap a bridge answer to its value, or the text of why not. */
function unwrap<T extends { ok: boolean }>(
  r: { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value: Extract<T, { ok: true }> } | { ok: false; error: string } {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: (r.value as { error?: string }).error ?? '' };
  return { ok: true, value: r.value as Extract<T, { ok: true }> };
}

export function DetectAntennas(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const s = useAntennas((a) => a);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [options, setOptions] = useState(false);
  const [drafts, setDrafts] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ value: Preview; unitIds: string[] } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const picked = useRef(false);

  const projectId = project?.id ?? null;
  const root = project?.root ?? null;
  const manifest = project?.manifest ?? null;
  const clouds = useMemo(
    () => (manifest?.layers ?? []).filter((l) => l.kind === 'pointcloud'),
    [manifest],
  );
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  const hasCloud = clouds.length > 0 && pkg === null;

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

  // the clouds finishing their load change the button
  useEffect(() => stage?.onLayerLoaded(bump), [stage]);

  const file = s.file;
  const showPanel = hasCloud && (file !== null || s.running || s.needsHint);

  // the boxes in the 3D view while the panel is shown
  useEffect(() => {
    if (!showPanel || !stage || !frame) return;
    return attachAntennaLayer(stage, frame, {
      getState: () => {
        const a = antennaStore.getState();
        return { file: a.file, selected: a.selected, hidden: a.hidden };
      },
      subscribe: (cb) => antennaStore.subscribe(cb),
      onPick: (id) => {
        picked.current = true;
        selectAntenna(id);
      },
    });
  }, [showPanel, stage, frame]);

  // a pick in the scene brings its row into view
  useEffect(() => {
    if (!picked.current || !s.selected) return;
    picked.current = false;
    const row = panel.current?.querySelector('[role="treeitem"][aria-selected="true"]');
    (row as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [s.selected]);

  // "click the tower": the next click on the cloud re-runs with it
  useEffect(() => {
    if (!s.needsHint || !stage) return;
    return armTowerPick(stage, (local) => {
      cancelHint();
      void runDetection({ towerHint: [local[0], local[2]] });
    });
  }, [s.needsHint, stage]);

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

  if (!project || !projectId || !hasCloud) return null;

  const visible = clouds.filter((l) => l.visible);
  const watched = s.cloudLayer ? clouds.filter((l) => l.id === s.cloudLayer) : visible;
  const loading = stage !== null && watched.some((l) => !stage.layerLoaded(l.id));
  const reason = s.running
    ? t('telecom.antennas.running')
    : loading
      ? t('telecom.antennas.loading')
      : undefined;
  const selected = file?.units.find((u) => u.id === s.selected);
  const aiProvider = selected?.ai?.provider;

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
        if (v.ok) await applyAiLabels(v.value, runId);
        else setNote(t('telecom.antennas.ai.skipped', { reason: v.error }));
      });
  };

  const exportCsv = async () => {
    if (!file) return;
    const r = await bridge.call('dialog:saveFile', {
      defaultName: 'antenna-inventory.csv',
      data: antennasToCsv(file, { includeDrafts: drafts }),
      title: t('telecom.antennas.csv'),
    });
    if (!r.ok) setNote(r.error);
    else if (r.value.error) setNote(r.value.error);
    else if (r.value.path !== null) setNote(t('telecom.antennas.csv.done', { path: r.value.path }));
  };

  return (
    <>
      <div className="telecom-actions">
        <Button
          data-testid="detect-antennas"
          tip={t('telecom.antennas.detect.tip')}
          {...(reason ? { disabledReason: reason } : {})}
          onClick={() => {
            void runDetection();
          }}
        >
          {t('telecom.antennas.detect')}
        </Button>
        <IconButton
          ref={opener}
          icon="settings"
          label={t('telecom.antennas.options')}
          aria-haspopup="dialog"
          aria-expanded={options}
          onClick={() => {
            setOptions((o) => !o);
          }}
        />
        <Popover
          open={options}
          onClose={() => {
            setOptions(false);
          }}
          opener={opener}
          title={t('telecom.antennas.options')}
        >
          {clouds.length > 1 && (
            <label style={{ display: 'grid', gap: 'var(--sp-2)' }}>
              {t('telecom.antennas.cloud')}
              <select
                value={s.cloudLayer ?? ''}
                onChange={(e) => {
                  setCloudLayer(e.target.value || null);
                }}
              >
                <option value="">{t('telecom.antennas.cloud.auto')}</option>
                {clouds.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={getAiLabelPref(projectId)}
              onChange={(e) => {
                setAiLabelPref(projectId, e.target.checked);
                bump();
              }}
            />
            {t('telecom.antennas.aiLabel')}
          </label>
          <small>{t('telecom.antennas.aiLabel.tip')}</small>
        </Popover>
      </div>
      {s.needsHint && (
        <div role="status" data-testid="antenna-hint">
          <b>{t('telecom.antennas.hint.title')}</b>
          <p className="telecom-help">{t('telecom.antennas.hint.body')}</p>
          <Button onClick={cancelHint}>{t('telecom.antennas.hint.cancel')}</Button>
        </div>
      )}
      {showPanel && (
        <section ref={panel} data-testid="antenna-panel" aria-label={t('telecom.antennas.title')}>
          {/* the scene's h1 is above; the unit details below are an h3 */}
          <h2 className="sr-only">{t('telecom.antennas.title')}</h2>
          {(s.message ?? note) && (
            <p className="telecom-help" role="status">
              {s.message ?? note}
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
          {file && (
            <div className="telecom-actions">
              <Button
                data-testid="antenna-csv"
                onClick={() => {
                  void exportCsv();
                }}
              >
                {t('telecom.antennas.csv')}
              </Button>
              <label style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={drafts}
                  onChange={(e) => {
                    setDrafts(e.target.checked);
                  }}
                />
                {t('telecom.antennas.csv.drafts')}
              </label>
            </div>
          )}
        </section>
      )}
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
