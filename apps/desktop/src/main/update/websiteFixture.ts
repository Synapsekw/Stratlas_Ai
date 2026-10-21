import type { WebsiteUpdateStatus } from '@aio/schema';
import { createWebsiteUpdater, type WebsiteStage } from './websiteUpdater';
import type { UpdateWorkGate } from './workGate';
/** Synthetic dependencies only. Main may construct this only in an unpackaged isolated E2E app. */
export function createWebsiteUpdateFixture(d: {
  policy: () => { enabled: boolean; offline: boolean };
  gate: UpdateWorkGate;
  setBusy: (busy: boolean) => void;
  emit: (status: WebsiteUpdateStatus) => void;
}) {
  let email: string | null = null;
  let stage: WebsiteStage | null = null;
  let ready = false;
  let finish: (() => void) | null = null;
  const requests: string[] = [];
  const control = {
    requests,
    restarts: 0,
    ready() {
      ready = true;
      finish?.();
    },
    busy(value: boolean) {
      d.setBusy(value);
    },
  };
  Object.defineProperty(globalThis, '__aioWebsiteUpdates', { value: control });
  const artifact = {
    releaseId: '00000000-0000-4000-8000-000000000001',
    artifactId: '00000000-0000-4000-8000-000000000002',
    version: '0.25.0',
    platform: 'win-x64' as const,
    filename: 'Setup.exe',
    bytes: 100,
    sha256: 'a'.repeat(64),
    notes: 'Synthetic app release notes',
  };
  const check = {
    schema: 'quadrion.updates/1' as const,
    targetAppVersion: '0.25.0',
    app: artifact,
    pipeline: {
      ...artifact,
      artifactId: '00000000-0000-4000-8000-000000000003',
      version: '0.20.0',
      filename: 'pipeline-pack.tar.gz',
      appRange: '>=0.25.0 <2.0.0',
      notes: 'Synthetic processing kit notes',
    },
  };
  return createWebsiteUpdater({
    currentVersion: '0.24.0',
    unsupportedReason: null,
    policy: d.policy,
    pipelineVersion: () => Promise.resolve('0.19.0'),
    client: {
      restore: () => Promise.resolve(email),
      forgetAccess: () => undefined,
      signIn: (value) => {
        requests.push('signIn');
        email = value;
        return Promise.resolve(value);
      },
      signOut: () => {
        email = null;
      },
      check: () => {
        requests.push('check');
        return Promise.resolve(check);
      },
    },
    store: {
      read: () => Promise.resolve(stage),
      write: (value) => {
        stage = value;
        return Promise.resolve();
      },
    },
    download: async (artifact, signal, progress) => {
      requests.push('download');
      progress(25, artifact.bytes);
      if (!ready)
        await new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
      signal.throwIfAborted();
      progress(artifact.bytes, artifact.bytes);
    },
    verify: () => Promise.resolve(),
    activate: () => Promise.resolve(() => Promise.resolve()),
    recover: () => Promise.resolve(false),
    recoveryAvailable: () => Promise.resolve(false),
    rollbackKit: () => Promise.resolve(),
    install: () => {
      control.restarts++;
      return Promise.resolve({ ok: true });
    },
    relaunch: () => {
      control.restarts++;
    },
    gate: d.gate,
    emit: d.emit,
    schedule: () => () => undefined,
  });
}
