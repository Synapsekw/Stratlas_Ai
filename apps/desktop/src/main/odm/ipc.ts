import type { IpcChannel, OdmGpuSetting, OdmInstallProgress } from '@aio/schema';
import type { Handler } from '../ipc';
import { installOdm, odmStatus, parkOdmStub, readRecord, removeOdm, type OdmDeps } from './install';

export type OdmChannel = Extract<IpcChannel, `odm:${string}`>;

/** Settings, Processing tools: status, install (one at a time), cancel, remove and the GPU line. */
export function registerOdmIpc(
  d: OdmDeps & {
    handle: <C extends OdmChannel>(channel: C, handler: Handler<C>) => void;
    emit(p: OdmInstallProgress): void;
    setGpu(gpu: OdmGpuSetting): Promise<void>;
  },
): {
  /**
   * The app quits: stop a running install as Cancel does. A start check then leaves ODM installed
   * and unverified, never a rollback racing the exit.
   */
  stopAll(): void;
} {
  let running: AbortController | null = null;
  let phase: OdmInstallProgress['phase'] | null = null;

  d.handle('odm:status', () => odmStatus(d, running !== null));

  d.handle('odm:install', async ({ replaceOther }) => {
    if (running) return { ok: false, error: 'ODM is already being installed.', code: 'busy' };
    const ctl = new AbortController();
    running = ctl;
    phase = null;
    try {
      return await installOdm(d, {
        replaceOther: replaceOther ?? false,
        signal: ctl.signal,
        onProgress: (p) => {
          phase = p.phase;
          d.emit(p);
        },
      });
    } finally {
      running = null;
      phase = null;
    }
  });

  // The download and the start check can be stopped; ODM's setup, once it runs, has to finish.
  // A stopped check leaves ODM installed and unverified, for Try again.
  d.handle('odm:cancel', () => {
    if (!running || (phase !== 'download' && phase !== 'verify' && phase !== 'check'))
      return { ok: false };
    running.abort();
    return { ok: true };
  });

  d.handle('odm:remove', () =>
    running
      ? { ok: false, error: 'ODM is being installed; wait for it to finish.', code: 'busy' }
      : removeOdm(d),
  );

  d.handle('odm:setGpu', async ({ gpu }) => {
    await d.setGpu(gpu);
    // an install of our own: `off` puts the placeholder back at once (the runner checks too)
    const rec = d.env.QUADRION_ODM_DIR ? null : await readRecord(d.dataRoot());
    if (rec && !running) {
      try {
        await parkOdmStub(rec.dir, gpu, d.env, d.system);
      } catch {
        // a running ODM holds the file; the runner sets it right before its next ODM call
      }
    }
    return { ok: true, status: await odmStatus(d, running !== null) };
  });

  return {
    stopAll: () => {
      running?.abort();
    },
  };
}
