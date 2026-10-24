/**
 * Settings, AI providers, AI for Ask AI: which AI looks (Automatic, Local only, Cloud), the local
 * model and its options, the cloud batch size, where the review queue starts, and how the local
 * model's class names map to the open project's classes. The choices are Ask AI's machine-local
 * preferences (`inspect/askAi/prefs`), so this page and the Ask AI bar share one store; the class
 * maps keep the keys the Detect dialog wrote.
 */
import { MAX_BATCH } from '@aio/ai';
import type { DetectorModelInfo } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { type ReactElement, useMemo, useState } from 'react';
import { classMapFor, writeClassMap } from '../../inspect/askAi/classMap';
import { type AskBackendPref, setAskAiPrefs, useAskAiPrefs } from '../../inspect/askAi/prefs';
import { useCall } from '../../shell';
import './askAiSettings.css';

const BACKENDS = [
  { id: 'auto', label: 'askAi.settings.auto' },
  { id: 'local', label: 'askAi.settings.local' },
  { id: 'cloud', label: 'askAi.settings.cloud' },
] as const satisfies readonly { id: AskBackendPref; label: string }[];

/** A number field that commits every valid entry; it shows the stored or default value again on blur. */
function NumberField({
  testId,
  label,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="aas-field">
      <span>{label}</span>
      <input
        key={value}
        type="number"
        data-testid={testId}
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = e.currentTarget.valueAsNumber;
          if (Number.isFinite(v) && v >= min && v <= max) onCommit(v);
        }}
      />
    </label>
  );
}

export function AskAiSettings(): ReactElement {
  const prefs = useAskAiPrefs((p) => p);
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const classes = useMemo(
    () => (project?.manifest.classCatalogues ?? []).flatMap((c) => c.classes),
    [project],
  );
  const res = useCall('inference:models', {}, projectId);
  const models = useMemo<DetectorModelInfo[]>(() => (res?.ok ? res.value.models : []), [res]);
  const model = models.find((m) => m.id === prefs.localModel) ?? models[0];
  const [saved, setSaved] = useState(0);
  const map = useMemo(
    () => (projectId && model ? classMapFor(projectId, model, classes) : null),
    // `saved` re-reads the stored map after a change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, model, classes, saved],
  );

  const tileSize = prefs.tile.size ?? model?.card.input.width ?? 640;
  const overlap = prefs.tile.overlap ?? Math.round(tileSize / 5);

  return (
    <div className="sblock ask-ai-settings" data-testid="ask-ai-settings-panel">
      <h2>{t('askAi.settings.title')}</h2>

      <fieldset className="aas-group">
        <legend>{t('askAi.settings.backend')}</legend>
        {BACKENDS.map((b) => (
          <label key={b.id} className="aas-radio">
            <input
              type="radio"
              name="ask-ai-backend"
              data-testid={`ask-ai-backend-${b.id}`}
              checked={prefs.backend === b.id}
              onChange={() => {
                setAskAiPrefs({ backend: b.id });
              }}
            />
            <span>{t(b.label)}</span>
          </label>
        ))}
      </fieldset>

      <label className="aas-field">
        <span>{t('askAi.settings.model')}</span>
        <select
          data-testid="ask-ai-model"
          value={model?.id ?? ''}
          disabled={models.length === 0}
          onChange={(e) => {
            setAskAiPrefs({ localModel: e.currentTarget.value || null });
          }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.card.name}
            </option>
          ))}
        </select>
      </label>

      <NumberField
        testId="ask-ai-min-confidence"
        label={t('askAi.settings.minConfidence')}
        value={prefs.minConfidence ?? model?.card.minConfidence ?? 0.25}
        min={0}
        max={1}
        step={0.05}
        onCommit={(v) => {
          setAskAiPrefs({ minConfidence: v });
        }}
      />

      <label className="aas-radio">
        <input
          type="checkbox"
          data-testid="ask-ai-tile"
          checked={prefs.tile.on}
          onChange={(e) => {
            setAskAiPrefs({ tile: { ...prefs.tile, on: e.currentTarget.checked } });
          }}
        />
        <span>{t('askAi.settings.tile')}</span>
      </label>
      <div className="aas-row">
        <NumberField
          testId="ask-ai-tile-size"
          label={t('askAi.settings.tileSize')}
          value={tileSize}
          min={32}
          max={8192}
          step={32}
          disabled={!prefs.tile.on}
          onCommit={(v) => {
            setAskAiPrefs({ tile: { ...prefs.tile, size: Math.round(v) } });
          }}
        />
        <NumberField
          testId="ask-ai-tile-overlap"
          label={t('askAi.settings.overlap')}
          value={overlap}
          min={0}
          max={4096}
          step={8}
          disabled={!prefs.tile.on}
          onCommit={(v) => {
            setAskAiPrefs({ tile: { ...prefs.tile, overlap: Math.round(v) } });
          }}
        />
      </div>

      <NumberField
        testId="ask-ai-batch"
        label={t('askAi.settings.batch')}
        value={prefs.cloudBatch}
        min={1}
        max={MAX_BATCH}
        step={1}
        onCommit={(v) => {
          setAskAiPrefs({ cloudBatch: Math.round(v) });
        }}
      />
      <NumberField
        testId="ask-ai-queue-threshold"
        label={t('askAi.settings.queueThreshold')}
        value={prefs.queueThreshold}
        min={0}
        max={1}
        step={0.05}
        onCommit={(v) => {
          setAskAiPrefs({ queueThreshold: v });
        }}
      />

      <h3 className="aas-sub">
        {t('askAi.settings.classMap', { project: project?.manifest.name ?? '' })}
      </h3>
      {projectId && model && map ? (
        <ul className="aas-map" data-testid="ask-ai-class-map">
          {model.card.classes.map((c) => (
            <li key={c}>
              <span className="mono">{c}</span>
              <select
                data-testid={`ask-ai-class-${c}`}
                aria-label={c}
                value={map[c] ?? ''}
                onChange={(e) => {
                  writeClassMap(projectId, model.id, { ...map, [c]: e.currentTarget.value });
                  setSaved((n) => n + 1);
                }}
              >
                <option value="">{t('askAi.mapping.keepName')}</option>
                {classes.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint" data-testid="ask-ai-class-map-none">
          {t('askAi.settings.classMapNone')}
        </p>
      )}
    </div>
  );
}
