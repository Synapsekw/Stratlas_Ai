// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shellState = {
  pkg: null as object | null,
  go: vi.fn(),
  openSettingsPage: vi.fn(),
};
const photo = { view: null as { kind: string } | null, openWizard: vi.fn(), close: vi.fn() };

vi.mock('./shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'none' }) },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
  shell: { getState: () => shellState },
}));
vi.mock('./photogrammetry/store', () => ({ photoUi: { getState: () => photo } }));

import { processingTools, resumeAfterTools } from './processingTools';

beforeEach(() => {
  shellState.pkg = null;
  shellState.go.mockClear();
  photo.openWizard.mockClear();
  processingTools.setState({ resume: 'create-maps' });
});

describe('resumeAfterTools', () => {
  it('goes back to the Create maps dialog and clears the way back', () => {
    resumeAfterTools();
    expect(shellState.go).toHaveBeenCalledWith('scene');
    expect(photo.openWizard).toHaveBeenCalledTimes(1);
    expect(processingTools.getState().resume).toBeNull();
  });

  it('in player mode neither opens the wizard nor changes the screen, and clears the way back', () => {
    shellState.pkg = { id: 'package' };
    resumeAfterTools();
    expect(photo.openWizard).not.toHaveBeenCalled();
    expect(shellState.go).not.toHaveBeenCalled();
    expect(processingTools.getState().resume).toBeNull();
  });
});
