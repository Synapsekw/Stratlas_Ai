// @vitest-environment jsdom
import { DEFAULT_RF_STUDY, type RfStudy } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { margins } from '@aio/rf';
import { t } from '@aio/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoverageLegend } from './CoverageLegend';
import { CLASS_HATCH, RSRP_RAMP, swatchBackground } from './coverageRamp';
import { loadRfLayer, rfLayer, setRfLayerStorage } from './coverageDisplay';
import type { RfView } from './rfStore';
import { assumptionsText } from './rfText';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  setRfLayerStorage(null);
  loadRfLayer(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const SECTORS = [
  { id: 'sec-a', name: 'S1' },
  { id: 'sec-b', name: 'S2' },
  { id: 'sec-c', name: 'S3' },
];

function show(view: RfView, study: RfStudy = DEFAULT_RF_STUDY) {
  act(() => {
    root.render(
      <CoverageLegend view={view} study={study} sectors={SECTORS} source={{ kind: 'preview' }} />,
    );
  });
}
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
/** A row's whole label, as a screen reader reads it (and its tip shows). */
const full = (id: string) =>
  host.querySelector(`[data-testid="${id}"] .sr-only`)?.textContent ?? '';
/** A row's compact line: the short name and the short value. */
const compact = (id: string) =>
  [...host.querySelectorAll(`[data-testid="${id}"] [aria-hidden="true"]`)]
    .map((e) => e.textContent)
    .join('|');

describe('the coverage legend', () => {
  it('names every RSRP class with its range, never by colour alone', () => {
    show('rsrp');
    expect(full('rf-legend-excellent')).toBe('Excellent, above -80 dBm');
    expect(full('rf-legend-good')).toBe('Good, -80 to -95 dBm');
    expect(full('rf-legend-fair')).toBe('Fair, -95 to -105 dBm');
    expect(full('rf-legend-poor')).toBe('Poor, -105 to -115 dBm');
    expect(full('rf-legend-none')).toBe('No service, no tint, below -115 dBm');
    // on screen each row is one compact line: the swatch, the name and the range
    expect(compact('rf-legend-excellent')).toBe('|Excellent|> −80');
    expect(compact('rf-legend-good')).toBe('|Good|−80…−95');
    expect(compact('rf-legend-none')).toBe('|No service|< −115');
    expect(host.querySelector('[data-testid="rf-legend"]')?.getAttribute('aria-label')).toBe(
      'Coverage legend',
    );
  });

  it('follows the study thresholds', () => {
    show('rsrp', {
      ...DEFAULT_RF_STUDY,
      thresholds: { excellentDbm: -75, goodDbm: -90, fairDbm: -100, poorDbm: -110 },
    });
    expect(full('rf-legend-excellent')).toContain('above -75 dBm');
    expect(full('rf-legend-poor')).toContain('-100 to -110 dBm');
    expect(full('rf-legend-none')).toContain('below -110 dBm');
    expect(compact('rf-legend-poor')).toContain('−100…−110');
  });

  it('names the hatch of each class when the hatch is on, and the classes Show from hides', () => {
    act(() => {
      rfLayer.setState({ hatch: true, showFrom: 'good' });
    });
    show('rsrp');
    expect(full('rf-legend-excellent')).toMatch(/^Excellent/);
    expect(full('rf-legend-good')).toContain('Good, striped');
    expect(full('rf-legend-fair')).toContain('Fair, hidden');
    expect(full('rf-legend-poor')).toContain('Poor, hidden');
    // the short name stays short; a hidden class is dimmed
    expect(compact('rf-legend-fair')).toMatch(/^\|Fair\|/);
    expect(host.querySelector('[data-testid="rf-legend-fair"]')?.hasAttribute('data-dim')).toBe(
      true,
    );
    // the swatch draws the same hatch as the map (jsdom does not keep oklch gradients in style)
    expect(swatchBackground(RSRP_RAMP.good, CLASS_HATCH.good, true)).toMatch(
      /^repeating-linear-gradient\(-45deg, oklch\([^)]+\) 0 1\.5px, transparent 1\.5px 5px\), oklch\(0\.84 0\.18 130\)$/,
    );
    expect(swatchBackground(RSRP_RAMP.good, CLASS_HATCH.good, false)).toBe('oklch(0.84 0.18 130)');
  });

  it('names each sector in the best-server view and both bands in the overlap view', () => {
    show('bestServer');
    expect(full('rf-legend-sector-sec-a')).toBe('S1');
    expect(full('rf-legend-sector-sec-c')).toBe('S3');
    show('overlap');
    expect(full('rf-legend-overlap-two')).toBe('2 servers, handover zone');
    expect(full('rf-legend-overlap-more')).toBe('3 or more, interference risk');
  });

  it('carries the indicative and assumptions line', () => {
    show('rsrp');
    expect(text('rf-legend-indicative')).toBe(
      'Indicative: flat ground, no buildings, untuned model, about 8 dB either way. Assumes outdoor use: 0 dB penetration, 3 dB body loss, 10.3 dB fade margin (90% cell edge, 8 dB shadowing), 13.3 dB in all; phone at 1.5 m.',
    );
  });

  it('names an indoor preset in lowercase with its whole margin', () => {
    show('rsrp', { ...DEFAULT_RF_STUDY, marginPreset: 'deep-indoor' });
    expect(text('rf-legend-indicative')).toContain(
      'Assumes deep indoor use: 20 dB penetration, 3 dB body loss, 10.3 dB fade margin (90% cell edge, 8 dB shadowing), 33.3 dB in all; phone at 1.5 m.',
    );
  });

  it('says the assumptions as the RF tab does, with the total margin the preview takes off', () => {
    const study: RfStudy = { ...DEFAULT_RF_STUDY, marginPreset: 'in-car', bodyLossDb: 1 };
    show('rsrp', study);
    const line = assumptionsText(t, study);
    expect(text('rf-legend-indicative')).toContain(line);
    expect(line).toContain(`${String(Math.round(margins(study).totalDb * 10) / 10)} dB in all`);
  });

  it('keeps the controls and the assumptions behind Details, closed, open again this session', () => {
    sessionStorage.clear();
    show('rsrp');
    const details = () =>
      host.querySelector<HTMLDetailsElement>('[data-testid="rf-legend-details"]');
    expect(details()?.open).toBe(false);
    expect(details()?.querySelector('summary')?.textContent).toBe('Details');
    expect(details()?.querySelector('[data-testid="rf-legend-opacity"]')).not.toBeNull();
    expect(details()?.querySelector('[data-testid="rf-legend-indicative"]')).not.toBeNull();
    act(() => {
      const d = details();
      if (!d) throw new Error('no details');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });
    expect(sessionStorage.getItem('quadrion.rfLegendDetails')).toBe('1');
    // a legend shown again (another view, the layer back on) opens as it was left
    act(() => {
      root.unmount();
    });
    root = createRoot(host);
    show('rsrp');
    expect(details()?.open).toBe(true);
    sessionStorage.clear();
  });

  it('sets the layer opacity from its slider (the Display row shows the same state)', () => {
    show('rsrp');
    const slider = host.querySelector<HTMLInputElement>('[data-testid="rf-legend-opacity"]');
    if (!slider) throw new Error('no slider');
    expect(slider.value).toBe('60');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '25');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rfLayer.getState().opacity).toBeCloseTo(0.25, 10);
    expect(host.querySelector('output')?.textContent).toBe('25%');
  });
});
