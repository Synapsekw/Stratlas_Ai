/**
 * Settings, AI providers, Detection models (BLD-10): the onnxruntime the app found and the
 * provider it runs on, the installed detector models with their cards and licences, and Import
 * model (the person confirms the licence first; main checks the card, SHA-256, licence gate and
 * layout before copying the model in).
 */
import { brand } from '@aio/brand';
import type { DetectorModelInfo, InferenceRuntime } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useState } from 'react';
import { bridge, shell, useCall, useShell } from '../../shell';
import './detectionModels.css';

export function providerLabel(p: InferenceRuntime['provider']): string {
  return p === 'dml'
    ? t('infer.provider.dml')
    : p === 'coreml'
      ? t('infer.provider.coreml')
      : t('infer.provider.cpu');
}

function ModelRow({ m, onRemove }: { m: DetectorModelInfo; onRemove: () => void }) {
  const c = m.card;
  return (
    <li className="infer-model" data-testid="infer-model">
      <div className="infer-model-h">
        <b>{c.name}</b>
        <span className="mono faint">{c.version}</span>
        <span className="infer-chip">
          {t(m.where === 'user' ? 'infer.model.where.user' : 'infer.model.where.pack')}
        </span>
        <span className="grow" />
        {m.where === 'user' && (
          <button
            type="button"
            className="btn ghost sm"
            aria-label={t('infer.model.removeLabel', { name: c.name })}
            onClick={onRemove}
          >
            {t('infer.model.remove')}
          </button>
        )}
      </div>
      <p className="faint">
        {t('infer.model.meta', {
          layout: c.layout,
          width: c.input.width,
          height: c.input.height,
          size: (m.sizeBytes / 1024 / 1024).toFixed(1),
        })}
      </p>
      <p>{t('infer.model.classes', { classes: c.classes.join(', ') })}</p>
      <p data-testid="infer-licence">
        {t('infer.model.licence', { licence: c.licence })}
        {' · '}
        {t('infer.model.source', { source: c.source })}
      </p>
    </li>
  );
}

export function DetectionModels() {
  const inference = useShell((s) => s.settings.inference);
  const [refresh, setRefresh] = useState(0);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const res = useCall('inference:models', {}, `${String(refresh)}|${inference?.provider ?? ''}`);
  const value = res?.ok ? res.value : null;
  const runtime = value?.runtime;

  const importModel = async () => {
    setError(null);
    setDone(null);
    const pick = await bridge.call('dialog:openFile', {
      title: t('infer.import.pick'),
      filters: [{ name: t('infer.import.filter'), extensions: ['onnx', 'json'] }],
    });
    if (!pick.ok || !pick.value.path) return;
    setBusy(true);
    const r = await bridge.call('inference:importModel', {
      path: pick.value.path,
      acceptLicence: accept,
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setDone(t('infer.import.done', { name: r.value.model.card.name }));
      setRefresh((n) => n + 1);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setDone(null);
    const r = await bridge.call('inference:removeModel', { id });
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    setRefresh((n) => n + 1);
  };

  return (
    <div className="sblock" data-testid="detection-models">
      <h2>{t('infer.settings.title')}</h2>
      <p className="help">{t('infer.settings.lead', { product: brand.productName })}</p>
      <div className="path-row" data-testid="infer-runtime">
        <Icon name={runtime?.available ? 'check' : 'warn'} size={14} className="faint" />
        {res === null ? (
          <span className="faint">{t('infer.runtime.looking')}</span>
        ) : !res.ok ? (
          <span>{res.error}</span>
        ) : runtime?.available ? (
          <span>
            {t('infer.runtime.on', {
              version: runtime.version ?? '',
              provider: providerLabel(runtime.provider),
            })}
          </span>
        ) : (
          <span>{t('infer.runtime.off', { problem: runtime?.problem ?? '' })}</span>
        )}
      </div>
      <label className="infer-row">
        <span className="faint">{t('infer.provider.label')}</span>
        <select
          className="ann-select"
          value={inference?.provider ?? 'auto'}
          data-testid="infer-provider"
          onChange={(e) => {
            void shell.getState().updateSettings({
              inference: { ...inference, provider: e.target.value === 'cpu' ? 'cpu' : 'auto' },
            });
          }}
        >
          <option value="auto">{t('infer.provider.auto')}</option>
          <option value="cpu">{t('infer.provider.cpuOnly')}</option>
        </select>
      </label>

      {value?.models.length === 0 && <p className="faint">{t('infer.models.none')}</p>}
      {value && value.models.length > 0 && (
        <ul className="infer-models">
          {value.models.map((m) => (
            <ModelRow key={`${m.where}:${m.id}`} m={m} onRemove={() => void remove(m.id)} />
          ))}
        </ul>
      )}

      <div className="infer-import">
        <p className="help">{t('infer.import.note')}</p>
        <label className="ann-check">
          <input
            type="checkbox"
            checked={accept}
            data-testid="infer-accept"
            onChange={(e) => {
              setAccept(e.target.checked);
            }}
          />
          {t('infer.import.accept')}
        </label>
        <div className="infer-row">
          <button
            type="button"
            className="btn"
            data-testid="infer-import"
            disabled={!accept || busy}
            onClick={() => void importModel()}
          >
            <Icon name="import" size={12} />
            {busy ? t('infer.import.busy') : t('infer.import.button')}
          </button>
          {done && (
            <span role="status" data-testid="infer-import-done">
              {done}
            </span>
          )}
        </div>
        {error && (
          <p className="ann-error" role="alert" data-testid="infer-import-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
