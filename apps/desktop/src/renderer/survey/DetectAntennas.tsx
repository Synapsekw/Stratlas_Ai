/**
 * The "Detect antennas" button in the Measure workbench's Telecom family, with its options (the
 * cloud, AI labelling), the "click the tower" hint when the tower is not found, and why a run
 * failed. The inventory is its own section (`telecom/AntennaSection.tsx`);
 * progress shows in the jobs chip.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import { Button, IconButton, Popover, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { useAntennaClouds } from '../telecom/AntennaRunner';
import { armTowerPick } from '../telecom/antennaScene';
import {
  cancelHint,
  getAiLabelPref,
  runDetection,
  setAiLabelPref,
  setCloudLayer,
  useAntennas,
} from '../telecom/antennaStore';

export function DetectAntennas(): ReactElement | null {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const s = useAntennas((a) => a);
  const clouds = useAntennaClouds();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [options, setOptions] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  // the clouds finishing their load change the button
  useEffect(() => stage?.onLayerLoaded(bump), [stage]);

  // "click the tower": the next click on the cloud re-runs with it
  useEffect(() => {
    if (!s.needsHint || !stage) return;
    return armTowerPick(stage, (local) => {
      cancelHint();
      void runDetection({ towerHint: [local[0], local[2]] });
    });
  }, [s.needsHint, stage]);

  if (!projectId || clouds.length === 0) return null;

  const visible = clouds.filter((l) => l.visible);
  const watched = s.cloudLayer ? clouds.filter((l) => l.id === s.cloudLayer) : visible;
  const loading = stage !== null && watched.some((l) => !stage.layerLoaded(l.id));
  const reason = s.running
    ? t('telecom.antennas.running')
    : loading
      ? t('telecom.antennas.loading')
      : undefined;

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
      {s.message && (
        <p className="telecom-help" role="status" data-testid="antenna-message">
          {s.message}
        </p>
      )}
    </>
  );
}
