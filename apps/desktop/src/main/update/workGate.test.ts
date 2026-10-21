import { describe, it, expect } from 'vitest';
import { createUpdateWorkGate, runWithUpdateWork, runUpdateHandover } from './workGate';
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
  it.each(['package:extract', 'change:compute'] as const)(
    'gates pending %s work and refuses starts during restart',
    async (channel) => {
      const gate = createUpdateWorkGate();
      let finish: () => void = () => undefined;
      const work = runWithUpdateWork(
        channel,
        gate,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      expect(gate.acquire()).toBeNull();
      finish();
      await work;
      const release = gate.acquire();
      expect(release).not.toBeNull();
      await expect(runWithUpdateWork(channel, gate, () => Promise.resolve())).rejects.toThrow(
        /restart/,
      );
      release?.();
    },
  );
  it('releases the gate after a successful macOS open-DMG action that keeps the app running', async () => {
    const gate = createUpdateWorkGate();
    let finish: (result: { ok: boolean }) => void = () => undefined;
    const opened = runUpdateHandover(
      () => gate.acquire(),
      false,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(() => gate.enter()).toThrow(/restart/);
    finish({ ok: true });
    expect(await opened).toEqual({ ok: true });
    const release = gate.enter();
    release();
    expect(gate.acquire()).not.toBeNull();
  });
  it('holds the gate through a successful installer quit handover', async () => {
    const gate = createUpdateWorkGate();
    await runUpdateHandover(
      () => gate.acquire(),
      true,
      () => Promise.resolve({ ok: true }),
    );
    expect(() => gate.enter()).toThrow(/restart/);
  });
});
