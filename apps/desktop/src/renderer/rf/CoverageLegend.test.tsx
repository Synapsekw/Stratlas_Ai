// @vitest-environment jsdom
import { DEFAULT_RF_STUDY, type RfStudy } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoverageLegend } from './CoverageLegend';
import { CLASS_HATCH, RSRP_RAMP, swatchBackground } from './coverageRamp';
import { loadRfLayer, rfLayer, setRfLayerStorage } from './coverageDisplay';
import type { RfView } from './rfStore';

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

describe('the coverage legend', () => {
  it('names every RSRP class with its range, never by colour alone', () => {
    show('rsrp');
    expect(text('rf-legend-excellent')).toBe('Excellentabove -80 dBm');
    expect(text('rf-legend-good')).toBe('Good-80 to -95 dBm');
    expect(text('rf-legend-fair')).toBe('Fair-95 to -105 dBm');
    expect(text('rf-legend-poor')).toBe('Poor-105 to -115 dBm');
    expect(text('rf-legend-none')).toBe('No service, no tintbelow -115 dBm');
    expect(host.querySelector('[data-testid="rf-legend"]')?.getAttribute('aria-label')).toBe(
      'Coverage legend',
    );
  });

  it('follows the study thresholds', () => {
    show('rsrp', {
      ...DEFAULT_RF_STUDY,
      thresholds: { excellentDbm: -75, goodDbm: -90, fairDbm: -100, poorDbm: -110 },
    });
    expect(text('rf-legend-excellent')).toContain('above -75 dBm');
    expect(text('rf-legend-poor')).toContain('-100 to -110 dBm');
    expect(text('rf-legend-none')).toContain('below -110 dBm');
  });

  it('names the hatch of each class when the hatch is on, and the classes Show from hides', () => {
    act(() => {
      rfLayer.setState({ hatch: true, showFrom: 'good' });
    });
    show('rsrp');
    expect(text('rf-legend-excellent')).toMatch(/^Excellent/);
    expect(text('rf-legend-good')).toContain('Good, striped');
    expect(text('rf-legend-fair')).toContain('Fair, hidden');
    expect(text('rf-legend-poor')).toContain('Poor, hidden');
    // the swatch draws the same hatch as the map (jsdom does not keep oklch gradients in style)
    expect(swatchBackground(RSRP_RAMP.good, CLASS_HATCH.good, true)).toMatch(
      /^repeating-linear-gradient\(-45deg, oklch\([^)]+\) 0 1\.5px, transparent 1\.5px 5px\), oklch\(0\.84 0\.18 130\)$/,
    );
    expect(swatchBackground(RSRP_RAMP.good, CLASS_HATCH.good, false)).toBe('oklch(0.84 0.18 130)');
  });

  it('names each sector in the best-server view and both bands in the overlap view', () => {
    show('bestServer');
    expect(text('rf-legend-sector-sec-a')).toBe('S1');
    expect(text('rf-legend-sector-sec-c')).toBe('S3');
    show('overlap');
    expect(text('rf-legend-overlap-two')).toBe('2 servershandover zone');
    expect(text('rf-legend-overlap-more')).toBe('3 or moreinterference risk');
  });

  it('carries the indicative and assumptions line', () => {
    show('rsrp');
    expect(text('rf-legend-indicative')).toBe(
      'Indicative: flat ground, no buildings, untuned model, about 8 dB either way. Assumes Outdoor, 13.3 dB of margin in all, phone at 1.5 m.',
    );
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
