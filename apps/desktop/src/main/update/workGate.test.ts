import { describe, it, expect } from 'vitest';
import { createUpdateWorkGate } from './workGate';
describe('update work gate', () => {
  it('reserves pending work synchronously and refuses a racing restart', () => {
    const gate = createUpdateWorkGate();
    const release = gate.enter();
    expect(gate.acquire()).toBeNull();
    release();
    const unlock = gate.acquire();
    expect(unlock).not.toBeNull();
    expect(() => gate.enter()).toThrow(/restart/i);
    unlock?.();
    expect(() => gate.enter()).not.toThrow();
  });
  it('checks live runtimes even when no IPC remains pending', () => {
    let busy = true;
    const gate = createUpdateWorkGate(() => busy);
    expect(gate.acquire()).toBeNull();
    busy = false;
    expect(gate.acquire()).not.toBeNull();
  });
});
