import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangeLegend, ChangeLegendView, formatChange } from './ChangeLegend';
import { PointCloudControls } from './PointCloudControls';
import { createPointcloudSettings } from './settings';

const unsigned = { label: 'Distance', unit: 'm', range: 0.3, diverging: false };
const signed = { ...unsigned, diverging: true };
const noop = () => undefined;

describe('ChangeLegend', () => {
  it('shows the ramp in metres from nothing to the far distance, with the threshold', () => {
    const html = renderToStaticMarkup(
      <ChangeLegendView
        scalar={unsigned}
        range={0.3}
        threshold={0.05}
        onThreshold={noop}
        hover={null}
      />,
    );
    expect(html).toContain('Change: distance to the earlier date');
    expect(html).toContain('>0.00 m<');
    expect(html).toContain('>0.15 m<');
    expect(html).toContain('>0.30 m<');
    expect(html).toContain('Hide changes under');
    expect(html).toMatch(/aria-label="Hide changes smaller than"[^>]*max="0.3"/);
    expect(html).toContain('>0.05 m<');
    expect(html).toContain('Point at the cloud to read its distance');
    expect(html).toContain('linear-gradient(to right, #9ca3af 0%');
    expect(html).not.toMatch(/[–—]/); // no en or em dashes in user-facing text
  });

  it('runs from minus to plus around zero for signed distances, and reads the pointer', () => {
    const html = renderToStaticMarkup(
      <ChangeLegendView
        scalar={signed}
        range={0.5}
        threshold={0}
        onThreshold={noop}
        hover={0.42}
      />,
    );
    expect(html).toContain('>-0.50 m<');
    expect(html).toContain('>0.00 m<');
    expect(html).toContain('>+0.50 m<');
    expect(html).toContain('Under the pointer: <span');
    expect(html).toContain('+0.42 m');
    expect(html).toContain('aria-label="Change colour ramp from -0.50 m to +0.50 m"');
  });

  it('stays hidden unless the clouds are coloured by change and a change cloud shows', () => {
    const store = createPointcloudSettings(null);
    expect(renderToStaticMarkup(<ChangeLegend store={store} scene={() => null} />)).toBe('');
  });

  it('formats metres', () => {
    expect(formatChange(0.3)).toBe('0.30 m');
    expect(formatChange(0.3, 'm', true)).toBe('+0.30 m');
    expect(formatChange(-0.123, 'm', true)).toBe('-0.12 m');
  });

  it('is not offered in the point cloud panel without a change cloud', () => {
    const store = createPointcloudSettings(null);
    const html = renderToStaticMarkup(<PointCloudControls store={store} rgb />);
    expect(html).toContain('>Flight<');
    expect(html).not.toContain('>Change<');
  });
});
