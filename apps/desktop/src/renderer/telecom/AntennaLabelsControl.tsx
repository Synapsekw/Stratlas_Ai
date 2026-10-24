/**
 * The Labels control at the bottom left of the 3D stage while the antennas are drawn: Off,
 * Selected or All. It keeps out of the top band, where the pointer wakes the stage island and the
 * island's open line would cover it on a narrow stage; it sits under the bottom-left corner slot
 * (40 px up). It sets the
 * session's labels mode; the selected unit's own labels show in every mode.
 */
import { t } from '@aio/ui';
import type { CSSProperties, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { setLabelMode, useAntennas, type AntennaLabelMode } from './antennaStore';

const MODES: readonly AntennaLabelMode[] = ['off', 'selected', 'all'];

const BAR: CSSProperties = {
  position: 'absolute',
  bottom: 'var(--sp-5)',
  left: 'var(--sp-5)',
  zIndex: 'var(--z-stage-ui)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 3,
  background: 'color-mix(in oklch, var(--bg-1) 92%, transparent)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-6)',
  font: 'var(--t-11) var(--f-ui)',
};

const SEGMENTS: CSSProperties = {
  display: 'flex',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-4)',
  overflow: 'hidden',
};

const segment = (on: boolean): CSSProperties => ({
  border: 0,
  margin: 0,
  padding: '3px 8px',
  font: 'inherit',
  cursor: 'pointer',
  background: on ? 'var(--acc-a20)' : 'transparent',
  color: on ? 'var(--acc)' : 'var(--fg-2)',
});

/** Drawn in `host`, the stage's canvas parent (a positioned box). */
export function AntennaLabelsControl({ host }: { host: HTMLElement }): ReactElement {
  const mode = useAntennas((a) => a.labelMode);
  const title = t('telecom.antennas.labels.title');
  return createPortal(
    <div data-testid="antenna-labels-control" data-antenna-labels-control="" style={BAR}>
      <span aria-hidden="true" style={{ color: 'var(--fg-3)', padding: '0 4px' }}>
        {title}
      </span>
      <div role="group" aria-label={title} style={SEGMENTS}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`antenna-labels-${m}`}
            aria-pressed={mode === m}
            style={segment(mode === m)}
            onClick={() => {
              setLabelMode(m);
            }}
          >
            {t(`telecom.antennas.labels.${m}`)}
          </button>
        ))}
      </div>
    </div>,
    host,
  );
}
