/** What the Processing engine card shows for an ODM status: pure, so a unit test pins every state. */
import { brand } from '@aio/brand';
import type { OdmInstallProgress, OdmState, OdmStatus } from '@aio/schema';
import { formatBytes, t, type MessageKey } from '@aio/ui';

export type EngineAction = 'install' | 'cancel' | 'update' | 'remove' | 'reinstall' | 'retry';

export interface EngineView {
  state: 'loading' | OdmState;
  tone: 'ok' | 'warn' | 'plain';
  title: MessageKey;
  detail: string | null;
  /** A problem the installed engine still works with (for example dense matching on the CPU). */
  warning: string | null;
  hardware: string;
  gpuOn: boolean;
  gpuDisabled: boolean;
  progress: { label: string; pct: number | null } | null;
  actions: EngineAction[];
}

const TITLE: Record<OdmState, MessageKey> = {
  'not-installed': 'engine.state.notInstalled',
  installing: 'engine.state.installing',
  installed: 'engine.state.installed',
  'update-available': 'engine.state.update',
  broken: 'engine.state.broken',
  unverified: 'engine.state.unverified',
  unsupported: 'engine.state.unsupported',
};

const TONE: Record<OdmState, EngineView['tone']> = {
  'not-installed': 'plain',
  installing: 'plain',
  installed: 'ok',
  'update-available': 'warn',
  broken: 'warn',
  unverified: 'warn',
  unsupported: 'warn',
};

function progressOf(p: OdmInstallProgress | null): { label: string; pct: number | null } {
  if (p?.phase === 'download') {
    const total = p.bytesTotal;
    const done = Math.min(p.bytesDone, total);
    return {
      label: t('engine.progress.download', { done: formatBytes(done), total: formatBytes(total) }),
      pct: total > 0 ? Math.round((done / total) * 100) : null,
    };
  }
  if (p?.phase === 'verify') return { label: t('engine.progress.verify'), pct: null };
  if (p?.phase === 'check') return { label: t('engine.progress.check'), pct: null };
  return { label: t('engine.progress.install'), pct: null };
}

/** The phase in words alone, with no figures: what a screen reader is told as the install moves on. */
export function phaseLabel(p: OdmInstallProgress | null): string {
  if (p?.phase === 'download') return t('engine.phase.download');
  if (p?.phase === 'verify') return t('engine.progress.verify');
  if (p?.phase === 'check') return t('engine.progress.check');
  return t('engine.progress.install');
}

export function processingEngineView(
  status: OdmStatus | null,
  progress: OdmInstallProgress | null,
  installing: boolean,
): EngineView {
  if (!status) {
    return {
      state: 'loading',
      tone: 'plain',
      title: 'tools.looking',
      detail: null,
      warning: null,
      hardware: '',
      gpuOn: false,
      gpuDisabled: true,
      progress: null,
      actions: [],
    };
  }
  const state: OdmState = installing ? 'installing' : status.state;
  const usable = status.gpu.nvidia !== null && status.gpu.cuda;
  const hardware = usable
    ? t(status.gpu.setting === 'off' ? 'engine.gpu.off' : 'engine.gpu.used', {
        name: status.gpu.nvidia ?? '',
      })
    : t('engine.gpu.none');
  const size = t('engine.size', {
    download: formatBytes(status.pinned.downloadBytes),
    installed: formatBytes(status.pinned.installedBytes),
  });

  let detail: string | null = null;
  if (state === 'not-installed') detail = size;
  else if (state === 'update-available') {
    const uses = t('engine.updateText', {
      product: brand.productName,
      version: status.pinned.version,
    });
    detail = `${uses} ${size}`;
  } else if (state === 'broken' || state === 'unsupported' || state === 'unverified')
    detail = status.problem ?? null;

  let actions: EngineAction[] = [];
  // the download and the start check can be stopped; the setup, once it runs, has to finish
  if (installing)
    actions =
      !progress || progress.phase === 'download' || progress.phase === 'check' ? ['cancel'] : [];
  else if (status.dev) actions = [];
  else if (state === 'not-installed') actions = ['install'];
  else if (state === 'installed') actions = ['remove'];
  else if (state === 'update-available') actions = ['update', 'remove'];
  else if (state === 'broken') actions = ['reinstall', 'remove'];
  // the start check ran out of time: Try again reruns only that check
  else if (state === 'unverified') actions = ['retry', 'remove'];

  return {
    state,
    tone: TONE[state],
    title: TITLE[state],
    detail,
    warning:
      (state === 'installed' || state === 'update-available') && status.problem
        ? status.problem
        : null,
    hardware,
    gpuOn: usable && status.gpu.setting === 'auto',
    gpuDisabled: !usable,
    progress: installing ? progressOf(progress) : null,
    actions,
  };
}
