import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { appBoundsDeps, setFileExtentSource } from './appBounds';

afterEach(() => {
  setFileExtentSource(() => Promise.resolve(null));
  workspace.setState({ project: null });
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
});
