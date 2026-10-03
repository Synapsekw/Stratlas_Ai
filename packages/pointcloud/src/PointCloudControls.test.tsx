import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PointCloudControls } from './PointCloudControls';
import { createPointcloudSettings } from './settings';

describe('PointCloudControls', () => {
  it('shows colour modes, size, budget and the EDL toggle bound to the store', () => {
    // static render reads the store's initial state, so seed it through storage
    const saved = JSON.stringify({ colourMode: 'height' });
    const storage = { getItem: () => saved, setItem: () => undefined } as unknown as Storage;
    const store = createPointcloudSettings(storage);
    const html = renderToStaticMarkup(<PointCloudControls store={store} />);
    expect(html).toContain('Colour');
    for (const label of ['RGB', 'Intensity', 'Height', 'Per flight']) expect(html).toContain(label);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Height/);
    expect(html).toContain('Point size');
    expect(html).toContain('Point budget');
    expect(html).toContain('6 M');
    expect(html).toContain('Eye-dome lighting');
    expect(html).not.toMatch(/[–—]/); // no en or em dashes in user-facing text
  });
});
