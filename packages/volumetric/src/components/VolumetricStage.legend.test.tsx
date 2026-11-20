// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { volumetric } from '../store';
import { VolumetricStage } from './VolumetricStage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const render = (node: React.ReactNode) => {
  root ??= createRoot(host);
  act(() => root?.render(node));
};
const legend = () => host.querySelector('.vol-legend');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  volumetric.setState({
    status: 'ready',
    surface: 'elev',
    relief: null,
    reliefFailed: false,
    // a ready store always holds its volumes file
    file: { captures: [], deadbandM: 0.1 } as never,
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({
    status: 'idle',
    surface: 'photo',
    relief: null,
    reliefFailed: false,
    file: null,
  });
});

describe('the Elevation legend of the 3D view', () => {
  it('says the heights are being read until they are', () => {
    render(<VolumetricStage stage={null} />);
    expect(legend()?.textContent).toContain('Reading the survey heights');
    act(() => {
      volumetric.setState({ relief: { auto: [48, 62], extent: [45, 70] } });
    });
    expect(legend()?.textContent).not.toContain('Reading the survey heights');
    expect(host.querySelector('[data-testid="vol-elev"]')).not.toBeNull();
  });

  it('says the heights could not be read once the read failed, not that it is still reading', () => {
    render(<VolumetricStage stage={null} />);
    act(() => {
      volumetric.setState({ reliefFailed: true });
    });
    expect(legend()?.textContent).toContain('The survey heights could not be read');
    expect(legend()?.textContent).not.toContain('Reading the survey heights');
    expect(host.querySelector('[data-testid="vol-elev-failed"]')?.getAttribute('role')).toBe(
      'status',
    );
  });

  it('the second view of a comparison says the same', () => {
    volumetric.setState({ reliefFailed: true });
    render(<VolumetricStage stage={null} display epoch="e1" />);
    const view = host.querySelector('[data-testid="vol-legend-view"]');
    expect(view?.textContent).toContain('The survey heights could not be read');
    expect(view?.textContent).not.toContain('Reading the survey heights');
  });
});
