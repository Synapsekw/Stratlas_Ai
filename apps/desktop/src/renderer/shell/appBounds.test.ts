import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBoundsDeps, setFileExtentSource } from './appBounds';

const { scene } = vi.hoisted(() => ({ scene: { current: null } }));
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveScene: () => scene.current,
}));

afterEach(() => {
  setFileExtentSource(() => Promise.resolve(null));
  workspace.setState({ project: null });
  scene.current = null;
});

describe('appBoundsDeps', () => {
  it('reads the open project and asks the registered file extent source', async () => {
    workspace.setState({
      project: { id: 'p', root: 'C:/p', manifest: { layers: [] } },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    expect(await appBoundsDeps().fileExtent('x')).toBeNull();
    setFileExtentSource((id) =>
      Promise.resolve(id === 'x' ? { min: [0, 0, 0], max: [1, 1, 1] } : null),
    );
    expect(await appBoundsDeps().fileExtent('x')).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(appBoundsDeps().sceneBox('x')).toBeNull(); // no 3D view in the test
  });

  it('casts the ground ray against the named layer only', () => {
    const raycastRay = vi.fn((): { point: { y: number } } | null => ({ point: { y: 7 } }));
    scene.current = { raycastRay };
    expect(appBoundsDeps().rayDown(3, 4, 'dsm')).toBe(7);
    expect(raycastRay).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      layer: 'dsm',
    });
    // the DSM not hit (no fallback onto the y = 0 plane): no ground
    raycastRay.mockReturnValueOnce(null);
    expect(appBoundsDeps().rayDown(3, 4, 'dsm')).toBeNull();
  });
});
