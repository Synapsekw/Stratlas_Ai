import { isAnnotateReadOnly } from '@aio/annotate';
import type { LayerPatch } from '@aio/schema';
import { formatDate, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useState } from 'react';
import { bridge } from '../shell';

/**
 * The survey date layers belong to (M8, `Layer.capture`): wins over the date in their names
 * (data-conventions section 13). Saved through `builder:updateLayers` with `{ capture }`; the
 * first option clears it ("work it out from the name").
 */
export async function setLayersCapture(
  layerIds: readonly string[],
  capture: string | null,
): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project || layerIds.length === 0) return 'No project is open.';
  const patch: LayerPatch = { capture };
  const r = await bridge.call('builder:updateLayers', {
    projectId: project.id,
    layerIds: [...layerIds],
    patch,
  });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  workspace.getState().replaceManifest(r.value.manifest);
  return null;
}

export function SurveyDateSelect({
  layerIds,
  label,
  noneLabel,
  testId,
}: {
  layerIds: readonly string[];
  label: string;
  noneLabel: string;
  testId: string;
}) {
  const t = useT();
  const captures = useWorkspace((s) => s.project?.manifest.captures ?? []);
  const layers = useWorkspace((s) => s.project?.manifest.layers ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (captures.length < 2 || layerIds.length === 0) return null;
  const mine = layers.filter((l) => layerIds.includes(l.id));
  const values = new Set(mine.map((l) => l.capture ?? ''));
  const value = values.size === 1 ? ([...values][0] ?? '') : '';
  const sorted = [...captures].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return (
    <div className="survey-date" data-testid={testId}>
      <label className="small">
        <span className="faint" title={t('change.surveyDateTip')}>
          {label}
        </span>{' '}
        <select
          className="input"
          value={value}
          disabled={busy || isAnnotateReadOnly()}
          onChange={(e) => {
            setBusy(true);
            setError(null);
            void setLayersCapture(layerIds, e.target.value || null).then((err) => {
              setBusy(false);
              setError(err);
            });
          }}
        >
          <option value="">{noneLabel}</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {formatDate(c.date)} · {c.label}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="notice danger small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Belongs to date..." for the selected layer (right panel, Selection). */
export function LayerDatePicker() {
  const t = useT();
  const selection = useWorkspace((s) => s.selection);
  const layer = useWorkspace((s) =>
    s.selection && (s.selection.kind === 'layer' || s.selection.kind === 'clip')
      ? s.project?.manifest.layers.find((l) => l.id === (s.selection?.layer ?? s.selection?.id))
      : undefined,
  );
  if (!selection || !layer || layer.kind === 'basemap' || layer.kind === 'legacy') return null;
  return (
    <SurveyDateSelect
      layerIds={[layer.id]}
      label={t('change.belongsTo')}
      noneLabel={t('change.belongsToNone')}
      testId="layer-survey-date"
    />
  );
}
