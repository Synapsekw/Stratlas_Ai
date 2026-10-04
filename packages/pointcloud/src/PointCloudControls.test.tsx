import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClassificationLegend } from './ClassificationLegend';
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

  it('shows the elevation range in metres with Auto while colouring by elevation', () => {
    const store = seeded({ colourMode: 'height' });
    const heights = { range: [-17, 76] as const, extent: [-30, 900] as const };
    const html = renderToStaticMarkup(
      <PointCloudControls store={store} rgb heights={heights} toElevation={(y) => 100 + y} />,
    );
    expect(html).toContain('Elevation range');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Auto</);
    expect(html).toMatch(/aria-label="Elevation ramp top"[^>]*min="-30"[^>]*max="900"/);
    expect(html).toMatch(/value="76"/);
    expect(html).toContain('176.0 m');
    expect(html).toContain('83.0 m');
    // not in other colour modes
    const rgb = renderToStaticMarkup(
      <PointCloudControls store={seeded({ colourMode: 'rgb' })} rgb heights={heights} />,
    );
    expect(rgb).not.toContain('Elevation range');
  });

  it('shows a hand-set elevation range with Auto off', () => {
    const live = seeded({ colourMode: 'height' });
    live.getState().setHeightRange([0, 40]);
    // a static render reads the initial state: hand it the current one
    const store = { ...live, getInitialState: live.getState };
    const heights = { range: [-17, 76] as const, extent: [-30, 900] as const };
    const html = renderToStaticMarkup(
      <PointCloudControls store={store} rgb heights={heights} toElevation={(y) => y} />,
    );
    expect(html).toMatch(/aria-pressed="false"[^>]*>Auto</);
    expect(html).toContain('40.0 m');
    expect(html).toContain('0.0 m');
  });

  it('disables RGB with a reason for intensity-only clouds and shows intensity instead', () => {
    const store = seeded({ colourMode: 'rgb' });
    const html = renderToStaticMarkup(<PointCloudControls store={store} rgb={false} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>RGB</);
    expect(html).toMatch(/title="[^"]*no colour[^"]*"[^>]*>RGB</i);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Intensity/);
  });
});

describe('classification', () => {
  it('offers Classification, disabled with a reason when no cloud carries classes', () => {
    const store = seeded({ colourMode: 'rgb' });
    const on = renderToStaticMarkup(<PointCloudControls store={store} rgb classes />);
    expect(on).toMatch(/<button[^>]*>Classification</);
    expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*>Classification</);
    const off = renderToStaticMarkup(<PointCloudControls store={store} rgb classes={false} />);
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Classification</);
    expect(off).toMatch(/title="[^"]*no classification[^"]*"[^>]*>Classification</i);
  });

  it('lists the classes present with their share and a show or hide toggle each', () => {
    const html = renderToStaticMarkup(
      <ClassificationLegend counts={{ 2: 600, 6: 300, 7: 100 }} hidden={[7]} />,
    );
    expect(html).toContain('data-component="classification-legend"');
    expect(html.indexOf('Ground')).toBeLessThan(html.indexOf('Building'));
    expect(html).toContain('60 %');
    expect(html).toMatch(
      /aria-pressed="true"[^>]*aria-label="Hide Ground"|aria-label="Hide Ground"[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(/aria-label="Show Low noise"/);
    expect(html).not.toMatch(/[–—]/);
  });

  it('renders nothing without classes', () => {
    expect(renderToStaticMarkup(<ClassificationLegend counts={null} hidden={[]} />)).toBe('');
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
