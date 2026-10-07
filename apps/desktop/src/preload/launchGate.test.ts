import { describe, expect, it } from 'vitest';
import { launchGateMode } from './launchGate';

describe('launchGateMode', () => {
  it('shows the launch screen in a normal run', () => {
    expect(launchGateMode({})).toBe('auto');
    expect(launchGateMode({ QUADRION_E2E: '0' })).toBe('auto');
  });

  it('skips it in an e2e run, so the existing specs land in the app', () => {
    expect(launchGateMode({ QUADRION_E2E: '1' })).toBe('skip');
    expect(launchGateMode({ STRATLAS_E2E: '1' })).toBe('skip');
  });

  it('QUADRION_SHOW_GATE=1 brings it back for its own spec', () => {
    expect(launchGateMode({ QUADRION_E2E: '1', QUADRION_SHOW_GATE: '1' })).toBe('auto');
  });

  it('QUADRION_SHOW_GATE=0 skips it in any run', () => {
    expect(launchGateMode({ QUADRION_SHOW_GATE: '0' })).toBe('skip');
  });
});
