// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { webglAvailable } from './SceneView';

describe('WebGL probe', () => {
  // Soak, 8 Oct: each 3D view mounted made a WebGL context here and never let it go.
  it('asks once per app and lets its context go', () => {
    const loseContext = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ getExtension: () => ({ loseContext }) } as unknown as RenderingContext);
    expect(webglAvailable()).toBe(true);
    expect(webglAvailable()).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
    getContext.mockRestore();
  });
});
