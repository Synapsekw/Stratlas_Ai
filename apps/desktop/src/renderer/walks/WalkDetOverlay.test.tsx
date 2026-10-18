// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalkDetOverlay, type OverlayBox } from './WalkDetOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const det = (id: string, x: number): Detection => ({
  id,
  pass: 'model-1.json',
  source: { kind: 'frame', layer: 'w', t: 2 },
  size: [2000, 1000],
  geom: { type: 'box', x, y: 480, w: 40, h: 40 },
  classId: 'helmet',
  severity: null,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'model', producer: 'local' },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('the detection overlay of the 360 view', () => {
  it('draws the boxes in front of the camera with their label and leaves out those behind', () => {
    const boxes: OverlayBox[] = [
      { detection: det('front', 980), color: '#ff7a2d', label: 'Helmet 87%' },
      { detection: det('behind', 0), color: '#ff7a2d', label: 'Helmet 50%' },
    ];
    act(() => {
      root.render(
        <WalkDetOverlay
          boxes={boxes}
          look={{ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }}
          width={800}
          height={600}
        />,
      );
    });
    expect(host.querySelector('[data-testid="walk-det-overlay"]')).not.toBeNull();
    const shown = [...host.querySelectorAll('[data-testid="walk-det-box"]')];
    expect(shown.map((g) => g.getAttribute('data-id'))).toEqual(['front']);
    expect(shown[0]?.querySelector('polygon')).not.toBeNull();
    expect(shown[0]?.textContent).toBe('Helmet 87%');
  });
});
