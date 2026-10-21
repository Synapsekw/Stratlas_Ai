import {
  WebsiteUpdateCheck,
  WebsiteVersion,
  packRangeRefusal,
  type WebsiteArtifact,
  type WebsiteUpdateStatus,
} from '@aio/schema';
import { z } from 'zod';
import type { WebsiteClient } from './websiteClient';
import type { UpdateWorkGate } from './workGate';
import { compareVersions } from '../jobs/pack';
export const WebsiteStage = z
  .object({
    schema: z.literal('quadrion.website-stage/1'),
    sourceAppVersion: WebsiteVersion,
    phase: z.enum(['download', 'ready', 'applying']),
    check: WebsiteUpdateCheck,
  })
  .strict();
export type WebsiteStage = z.infer<typeof WebsiteStage>;
interface Result {
  ok: boolean;
  error?: string;
}
export interface WebsiteUpdaterDeps {
  currentVersion: string;
  unsupportedReason: string | null;
  policy: () => { enabled: boolean; offline: boolean };
  pipelineVersion: () => Promise<string | null>;
  client: Pick<WebsiteClient, 'restore' | 'signIn' | 'signOut' | 'forgetAccess' | 'check'>;
  store: { read: () => Promise<unknown>; write: (stage: WebsiteStage | null) => Promise<void> };
  download: (
    artifact: WebsiteArtifact,
    signal: AbortSignal,
    progress: (received: number, total: number) => void,
  ) => Promise<void>;
  verify: (
    check: WebsiteUpdateCheck,
    signal: AbortSignal,
    repairInactive?: boolean,
  ) => Promise<void>;
  activate: (check: WebsiteUpdateCheck) => Promise<() => Promise<void>>;
  recover: (stage: WebsiteStage) => Promise<boolean>;
  recoveryAvailable: () => Promise<boolean>;
  rollbackKit: () => Promise<void>;
  install: (app: WebsiteArtifact) => Promise<Result>;
  relaunch: () => void;
  gate: UpdateWorkGate;
  emit: (status: WebsiteUpdateStatus) => void;
  schedule?: (callback: () => void, ms: number) => () => void;
}
const component = (a: WebsiteArtifact | null) =>
  a ? { version: a.version, notes: a.notes, received: 0, total: a.bytes, verified: false } : null;
export function validateWebsiteCheck(check: WebsiteUpdateCheck, current: string) {
  WebsiteVersion.parse(current);
  WebsiteUpdateCheck.parse(check);
  if (check.app) {
    if (
      check.app.version !== check.targetAppVersion ||
      compareVersions(check.targetAppVersion, current) <= 0 ||
      !check.app.filename.toLowerCase().endsWith('.exe')
    )
      throw new Error('The website app target is invalid.');
  } else if (check.targetAppVersion !== current)
    throw new Error('The website target does not match this app.');
  if (check.pipeline) {
    if (
      !check.pipeline.filename.toLowerCase().endsWith('.tar.gz') ||
      packRangeRefusal(check.pipeline.appRange, check.targetAppVersion)
    )
      throw new Error('The website processing kit is incompatible.');
  }
  if (check.app && !check.pipeline)
    throw new Error('The app update has no verified compatible processing kit.');
}
export function createWebsiteUpdater(d: WebsiteUpdaterDeps) {
  let stage: WebsiteStage | null = null;
  let task: AbortController | null = null;
  let applying = false;
  let recoveryFailed = false;
  let stopTimer: (() => void) | null = null;
  let state: WebsiteUpdateStatus = {
    accountEmail: null,
    phase: d.unsupportedReason ? 'unsupported' : 'signed-out',
    currentAppVersion: d.currentVersion,
    currentPipelineVersion: null,
    app: null,
    pipeline: null,
    error: null,
    restartAvailable: false,
    restartReason: null,
    recoveryAvailable: false,
    unsupportedReason: d.unsupportedReason,
  };
  const network = () => d.policy().enabled && !d.policy().offline;
  const send = (patch: Partial<WebsiteUpdateStatus> = {}) => {
    state = { ...state, ...patch };
    d.emit({ ...state });
  };
  const current = (c: AbortController) => {
    c.signal.throwIfAborted();
    if (task !== c) throw new Error('Cancelled update operation.');
  };
  function cancel() {
    task?.abort();
    task = null;
    d.client.forgetAccess();
  }
  function display(s: WebsiteStage) {
    send({ app: component(s.check.app), pipeline: component(s.check.pipeline) });
  }
  function ready() {
    send({
      phase: 'ready',
      restartAvailable: !d.unsupportedReason,
      restartReason: d.unsupportedReason,
      error: null,
      app: state.app ? { ...state.app, received: state.app.total, verified: true } : null,
      pipeline: state.pipeline
        ? { ...state.pipeline, received: state.pipeline.total, verified: true }
        : null,
    });
  }
  function paused() {
    send({
      phase: d.unsupportedReason
        ? 'unsupported'
        : !network()
          ? 'paused'
          : state.accountEmail
            ? 'idle'
            : 'signed-out',
      restartAvailable: false,
      restartReason: d.unsupportedReason,
    });
  }
  async function stageCheck(check: WebsiteUpdateCheck, c: AbortController) {
    current(c);
    validateWebsiteCheck(check, d.currentVersion);
    if (!check.app && !check.pipeline) {
      stage = null;
      await d.store.write(null);
      current(c);
      send({ phase: 'idle', app: null, pipeline: null, error: null });
      return;
    }
    stage = {
      schema: 'quadrion.website-stage/1',
      sourceAppVersion: d.currentVersion,
      phase: 'download',
      check,
    };
    await d.store.write(stage);
    current(c);
    display(stage);
    for (const kind of ['app', 'pipeline'] as const) {
      const artifact = check[kind];
      if (!artifact) continue;
      send({ phase: 'downloading' });
      await d.download(artifact, c.signal, (received, total) => {
        if (task === c && !c.signal.aborted)
          send({
            [kind]: {
              version: artifact.version,
              notes: artifact.notes,
              received,
              total,
              verified: false,
            },
          });
      });
      current(c);
    }
    send({ phase: 'verifying' });
    await d.verify(check, c.signal, true);
    current(c);
    const complete: WebsiteStage = { ...stage, phase: 'ready' };
    await d.store.write(complete);
    current(c);
    stage = complete;
    ready();
  }
  async function check(): Promise<Result> {
    if (recoveryFailed)
      return {
        ok: false,
        error: 'Return to the previous app version before checking for updates.',
      };
    if (stage?.phase === 'ready') return { ok: true };
    if (applying || task)
      return { ok: false, error: 'A website update operation is already running.' };
    if (d.unsupportedReason) return { ok: false, error: d.unsupportedReason };
    if (!network())
      return {
        ok: false,
        error: 'Website updates are paused. Turn off offline-only and enable automatic updates.',
      };
    const c = new AbortController();
    task = c;
    send({ phase: 'checking', error: null, restartAvailable: false });
    try {
      if (!state.accountEmail) {
        const email = await d.client.restore(c.signal);
        current(c);
        if (!email) {
          paused();
          return { ok: false, error: 'Sign in to your website account.' };
        }
        send({ accountEmail: email });
      }
      // Fresh authentication on each scheduled check checks membership and rotates credentials.
      else {
        const email = await d.client.restore(c.signal);
        current(c);
        if (!email) throw new Error('Sign in to your website account.');
        send({ accountEmail: email });
      }
      const installed = await d.pipelineVersion();
      current(c);
      const found = await d.client.check(d.currentVersion, c.signal, installed ?? undefined);
      current(c);
      if (
        !found.app &&
        found.pipeline &&
        installed &&
        compareVersions(found.pipeline.version, installed) <= 0
      )
        throw new Error('The website offered a processing kit that is not newer.');
      await stageCheck(found, c);
      return { ok: true };
    } catch {
      if (task === c && !c.signal.aborted)
        send({
          phase: 'error',
          error:
            'Website updates could not be checked or verified. Check your account and connection, then try again.',
          restartAvailable: false,
        });
      return { ok: false, error: 'Website updates could not be checked or verified.' };
    } finally {
      if (task === c) task = null;
    }
  }
  return {
    status: () => ({
      ...state,
      restartReason:
        state.restartAvailable && d.gate.busy()
          ? 'Finish processing, imports and tool installation before restarting.'
          : state.restartReason,
    }),
    check,
    async startup(background = false) {
      state.currentPipelineVersion = await d.pipelineVersion();
      state.recoveryAvailable = await d.recoveryAvailable();
      const parsed = WebsiteStage.safeParse(await d.store.read());
      if (parsed.success) {
        stage = parsed.data;
        try {
          validateWebsiteCheck(stage.check, stage.sourceAppVersion);
        } catch {
          stage = null;
          await d.store.write(null);
          send({
            phase: 'error',
            restartAvailable: false,
            error: 'The saved update metadata is invalid. Check again.',
          });
          return;
        }
        let recovered = false;
        if (stage.phase === 'applying') {
          try {
            recovered = await d.recover(stage);
          } catch {
            recoveryFailed = true;
            d.gate.blockWork(
              'The target processing kit could not be verified. Return to the previous app version.',
            );
            send({
              phase: 'error',
              restartAvailable: false,
              error:
                'The target processing kit could not be verified. Return to the previous app version in About and updates.',
            });
            return;
          }
        }
        if (recovered) {
          state.currentPipelineVersion = await d.pipelineVersion();
          state.recoveryAvailable = await d.recoveryAvailable();
          send({ phase: 'idle' });
        } else if (
          stage.phase === 'applying' &&
          !stage.check.app &&
          stage.sourceAppVersion === d.currentVersion
        ) {
          // A verified selector mismatch abandons this kit-only activation. Keep app
          // installer recovery journals on their existing path below.
          await d.store.write(null);
          stage = null;
        } else if (stage.sourceAppVersion === d.currentVersion) {
          try {
            validateWebsiteCheck(stage.check, d.currentVersion);
            display(stage);
            if (stage.phase !== 'download') {
              await d.verify(stage.check, new AbortController().signal);
              stage = { ...stage, phase: 'ready' };
              await d.store.write(stage);
              ready();
            }
          } catch {
            stage = null;
            await d.store.write(null);
            send({ phase: 'error', error: 'The saved update could not be verified. Check again.' });
          }
        } else {
          stage = null;
          await d.store.write(null);
        }
      }
      if (state.phase !== 'ready' && stage?.phase !== 'applying') {
        if (network() && !d.unsupportedReason) {
          if (background) void check();
          else await check();
        } else paused();
      }
      const schedule =
        d.schedule ??
        ((cb, ms) => {
          const timer = setInterval(cb, ms);
          timer.unref();
          return () => {
            clearInterval(timer);
          };
        });
      stopTimer = schedule(
        () => {
          if (state.phase !== 'ready' && network()) void check();
        },
        6 * 60 * 60 * 1000,
      );
    },
    async rendererReady() {
      if (recoveryFailed) throw new Error('The target processing kit could not be confirmed.');
      if (stage?.phase === 'applying' && stage.check.targetAppVersion === d.currentVersion) {
        if (!(await d.recover(stage)))
          throw new Error('The target processing kit could not be confirmed.');
        await d.store.write(null);
        stage = null;
        send({
          phase: 'idle',
          recoveryAvailable: await d.recoveryAvailable(),
          currentPipelineVersion: await d.pipelineVersion(),
        });
      }
    },
    policyChanged() {
      cancel();
      if (state.phase === 'ready' || applying) return;
      paused();
      if (network() && !d.unsupportedReason) void check();
    },
    async signIn(email: string, password: string): Promise<Result> {
      if (!network())
        return {
          ok: false,
          error: 'Website updates are paused. Turn off offline-only and enable automatic updates.',
        };
      if (task || applying)
        return { ok: false, error: 'A website update operation is already running.' };
      const c = new AbortController();
      task = c;
      try {
        const accountEmail = await d.client.signIn(email, password, c.signal);
        current(c);
        send({ accountEmail, error: null });
        task = null;
        if (state.phase !== 'ready') void check();
        return { ok: true };
      } catch {
        if (task === c && !c.signal.aborted)
          send({ error: 'Sign-in failed. Check your website membership and credentials.' });
        return {
          ok: false,
          error: 'Sign-in failed. Check your website membership and credentials.',
        };
      } finally {
        if (task === c) task = null;
      }
    },
    signOut(): Result {
      cancel();
      try {
        d.client.signOut();
        send({ accountEmail: null, error: null });
        if (state.phase !== 'ready' && !applying) paused();
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: 'The website credential could not be removed from the OS vault.',
        };
      }
    },
    async restart(): Promise<Result> {
      if (stage?.phase !== 'ready' || applying || task)
        return { ok: false, error: 'No complete update is ready.' };
      if (d.unsupportedReason) return { ok: false, error: d.unsupportedReason };
      const release = d.gate.acquire();
      if (!release)
        return {
          ok: false,
          error: 'Finish processing, imports and tool installation before restarting.',
        };
      applying = true;
      send({ phase: 'applying', restartAvailable: false, error: null });
      let undo: (() => Promise<void>) | null = null;
      let verified = false;
      try {
        await d.verify(stage.check, new AbortController().signal);
        verified = true;
        stage = { ...stage, phase: 'applying' };
        await d.store.write(stage);
        undo = await d.activate(stage.check);
        if (stage.check.app) {
          const result = await d.install(stage.check.app);
          if (!result.ok) throw new Error('The app installer did not start.');
        } else d.relaunch();
        return { ok: true };
      } catch {
        if (!verified) {
          stage = { ...stage, phase: 'download' };
          await d.store.write(stage).catch(() => undefined);
          applying = false;
          release();
          display(stage);
          send({
            phase: 'error',
            restartAvailable: false,
            restartReason: null,
            error: 'The saved update failed verification. Check again to download and verify it.',
          });
          return {
            ok: false,
            error: 'The saved update failed verification. Check again to download and verify it.',
          };
        }
        try {
          await undo?.();
        } catch {
          recoveryFailed = true;
          applying = false;
          release();
          d.gate.blockWork(
            'The previous processing kit selection could not be restored. Restart the app for recovery.',
          );
          send({
            phase: 'error',
            restartAvailable: false,
            error:
              'The previous processing kit selection could not be restored. Restart the app for recovery.',
          });
          return {
            ok: false,
            error: 'The previous processing kit selection could not be restored.',
          };
        }
        stage = { ...stage, phase: 'ready' };
        await d.store.write(stage).catch(() => undefined);
        applying = false;
        release();
        ready();
        send({
          error: 'The update could not be applied. Your previous selection has been restored.',
        });
        return { ok: false, error: 'The update could not be applied.' };
      }
    },
    async rollbackKit(): Promise<Result> {
      const release = d.gate.acquire();
      if (!release)
        return {
          ok: false,
          error: 'Finish processing, imports and tool installation before restarting.',
        };
      try {
        const kitStage =
          stage?.phase === 'applying' &&
          !stage.check.app &&
          stage.sourceAppVersion === d.currentVersion
            ? stage
            : null;
        if (await d.recoveryAvailable()) await d.rollbackKit();
        else if (!kitStage || (await d.recover(kitStage)))
          throw new Error('No previous processing kit.');
        // Persist retirement after the selector change. If this write fails, the old
        // journal plus strict selector comparison makes retry/startup idempotent.
        if (kitStage) {
          await d.store.write(null);
          stage = null;
        }
        d.relaunch();
        return { ok: true };
      } catch {
        release();
        return { ok: false, error: 'The previous processing kit could not be restored.' };
      }
    },
    stop() {
      cancel();
      stopTimer?.();
    },
  };
}
