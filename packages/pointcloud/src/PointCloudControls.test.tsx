import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ElevationLegend, elevationColour, elevationGradient } from './ElevationLegend';
import { PointCloudControls } from './PointCloudControls';
import { createPointcloudSettings } from './settings';

const seeded = (v: object) => {
  const saved = JSON.stringify(v);
  return createPointcloudSettings({
    getItem: () => saved,
    setItem: () => undefined,
  } as unknown as Storage);
};

describe('PointCloudControls', () => {
  it('shows colour by RGB, Elevation, Intensity and Flight, size, budget and EDL', () => {
    // static render reads the store's initial state, so seed it through storage
    const store = seeded({ colourMode: 'height' });
    const html = renderToStaticMarkup(<PointCloudControls store={store} rgb />);
    expect(html).toContain('Colour by');
    const order = ['RGB', 'Elevation', 'Intensity', 'Flight'].map((l) => html.indexOf(`>${l}<`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Elevation/);
    expect(html).toContain('Point size');
    expect(html).toContain('Point budget');
    expect(html).toContain('6 M');
    expect(html).toContain('Eye-dome lighting');
    expect(html).not.toMatch(/[–—]/); // no en or em dashes in user-facing text
  });

  it('disables RGB with a reason for intensity-only clouds and shows intensity instead', () => {
    const store = seeded({ colourMode: 'rgb' });
    const html = renderToStaticMarkup(<PointCloudControls store={store} rgb={false} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>RGB</);
    expect(html).toMatch(/title="[^"]*no colour[^"]*"[^>]*>RGB</i);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Intensity/);
  });
});

describe('ElevationLegend', () => {
  it('uses the shader ramp: dark blue at the bottom, red at the top', () => {
    const [r0, g0, b0] = elevationColour(0);
    expect(b0).toBeGreaterThan(r0);
    expect(b0).toBeGreaterThan(g0);
    const [r1, g1, b1] = elevationColour(1);
    expect(r1).toBeGreaterThan(g1);
    expect(r1).toBeGreaterThan(b1);
    expect(elevationColour(0.5)[1]).toBeGreaterThan(0.9); // green in the middle
    expect(elevationGradient()).toMatch(/^linear-gradient\(to top, rgb\(/);
  });

  it('labels the range in metres of elevation, top to bottom', () => {
    const html = renderToStaticMarkup(
      <ElevationLegend range={[-2.04, 41.5]} toElevation={(y) => y + 100} />,
    );
    expect(html).toContain('Elevation');
    const ticks = html.slice(html.indexOf('>Elevation<'));
    expect(ticks.indexOf('141.5 m')).toBeGreaterThan(0);
    expect(ticks.indexOf('141.5 m')).toBeLessThan(ticks.indexOf('98.0 m'));
    expect(html).not.toMatch(/[–—]/);
  });
});
