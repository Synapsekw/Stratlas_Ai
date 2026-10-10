/**
 * Settings, Processing tools: the one home of the pipeline pack. What it is in a sentence, the
 * version in use and where it lives, whether it is up to date for this version of the app,
 * **Install or update from file** (a `.tar.gz` checked and unpacked by main, with progress and
 * cancel), a one-click offer when a newer pack file is found on this computer, and the packs no
 * longer in use with their sizes, removable to the bin. Nothing is downloaded.
 *
 * Other screens get here with `openProcessingTools()` (renderer/processingTools.ts).
 */
import { brand } from '@aio/brand';
import type { InstalledPack, PackInstallProgress, PipelinePackStatus } from '@aio/schema';
import { formatBytes, Icon, t, type IconName, type MessageKey } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { processingTools, useProcessingTools } from '../../processingTools';
import { useShell } from '../../shell';
import './processingTools.css';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

const STATE: Record<
  PipelinePackStatus['state'],
  { label: MessageKey; tone: 'ok' | 'warn' | 'plain'; icon: IconName }
> = {
  ok: { label: 'tools.state.ok', tone: 'ok', icon: 'check' },
  'too-old': { label: 'tools.state.tooOld', tone: 'warn', icon: 'warn' },
  incompatible: { label: 'tools.state.incompatible', tone: 'warn', icon: 'warn' },
  missing: { label: 'tools.state.missing', tone: 'warn', icon: 'warn' },
  dev: { label: 'tools.state.dev', tone: 'plain', icon: 'lock' },
};

const WHERE = {
  downloads: 'tools.where.downloads',
  app: 'tools.where.app',
  runtime: 'tools.where.runtime',
} as const satisfies Record<string, MessageKey>;

/** The sentence under the progress bar, and how far it is (null: no figure to show). */
export function progressText(p: PackInstallProgress | null): { text: string; pct: number | null } {
  if (!p || p.phase === 'unpack') {
    const total = p?.bytesTotal ?? 0;
    const done = Math.min(p?.bytesDone ?? 0, total);
    if (total <= 0) return { text: t('tools.progress.label'), pct: null };
    const files = t('tools.progress.files', { files: (p?.entries ?? 0).toLocaleString('en-US') });
    return {
      text: `${t('tools.progress.unpack', { done: formatBytes(done), total: formatBytes(total) })}, ${files}`,
      pct: Math.round((done / total) * 100),
    };
  }
  if (p.phase === 'check') return { text: t('tools.progress.check'), pct: 100 };
  return { text: t('tools.progress.activate'), pct: 100 };
}

function Status({ status }: { status: PipelinePackStatus | null }) {
  const state = status ? STATE[status.state] : null;
  const product = brand.productName;
  return (
    <>
      <div className="about-kv pt-info" data-testid="tools-info">
        <span>{t('tools.status')}</span>
        <span
          className={`pt-state ${state?.tone ?? 'plain'}`}
          data-testid="tools-state"
          data-state={status?.state ?? 'loading'}
        >
          {state && <Icon name={state.icon} size={14} />}
          {state ? t(state.label, { product }) : t('tools.looking')}
        </span>
        <span />
        <span>{t('tools.version')}</span>
        <span className="mono" data-testid="tools-version">
          {status?.version ?? t('tools.none')}
        </span>
        <span />
        <span>{t('tools.location')}</span>
        <span className="mono" title={status?.dir ?? status?.runtimeDir}>
          {status?.dir ?? status?.runtimeDir ?? ''}
        </span>
        <span />
        {status?.bytes !== undefined && (
          <>
            <span>{t('tools.size')}</span>
            <span className="mono">{formatBytes(status.bytes)}</span>
            <span />
          </>
        )}
      </div>
      {status && status.needs.length > 0 && (
        <ul className="pt-needs" data-testid="tools-needs">
          {status.needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {/* why no pack is usable; "there is none, install one in Settings" says nothing new here */}
      {status?.problem && (status.state === 'incompatible' || status.others.length > 0) && (
        <p className="help pt-problem" data-testid="tools-problem">
          {status.problem}
        </p>
      )}
      {status?.state === 'dev' && <p className="help pt-problem">{t('tools.dev')}</p>}
    </>
  );
}

function Install() {
  const offer = useProcessingTools((s) => s.offer);
  const installing = useProcessingTools((s) => s.installing);
  const progress = useProcessingTools((s) => s.progress);
  const replace = useProcessingTools((s) => s.replace);
  const error = useProcessingTools((s) => s.error);
  const note = useProcessingTools((s) => s.note);
  const pt = processingTools.getState();
  const running = progressText(progress);
  return (
    <div className="opt-card" data-testid="tools-install">
      <div className="oc-head">
        <div>
          <b>{t('tools.install')}</b>
          <span>{t('tools.installHint')}</span>
        </div>
        <button
          type="button"
          className="btn sm"
          data-testid="tools-choose"
          disabled={installing}
          onClick={() => void pt.choose()}
        >
          <Icon name="import" size={14} />
          {t('tools.choose')}
        </button>
      </div>
      {offer && !installing && !replace && (
        <div className="notice ok" data-testid="tools-offer">
          <Icon name="download" size={14} />
          <span className="pt-offer">
            <b>{t('tools.offerTitle')}</b>
            <span className="mono" title={offer.path}>
              {fileName(offer.path)}
            </span>
            <span className="faint">{formatBytes(offer.bytes)}</span>
          </span>
          <button
            type="button"
            className="btn sm primary"
            data-testid="tools-offer-install"
            onClick={() => void pt.install(offer.path)}
          >
            {t('tools.offer', { version: offer.version, where: t(WHERE[offer.where]) })}
          </button>
        </div>
      )}
      {installing && (
        <div className="pt-progress" data-testid="tools-progress">
          <div className="pt-progress-h">
            <span role="status">{running.text}</span>
            <button
              type="button"
              className="btn sm ghost"
              data-testid="tools-cancel"
              onClick={() => {
                pt.cancel();
              }}
            >
              {t('tools.cancel')}
            </button>
          </div>
          <div
            className={`toast-bar${running.pct === null ? ' busy' : ''}`}
            role="progressbar"
            aria-label={t('tools.progress.label')}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(running.pct === null ? {} : { 'aria-valuenow': running.pct })}
          >
            <i style={{ width: `${String(running.pct ?? 30)}%` }} />
          </div>
        </div>
      )}
      {replace && (
        <div className="notice warn" role="alert" data-testid="tools-replace">
          <Icon name="warn" size={14} />
          <span>
            <b>{t('tools.replace.title', { version: replace.version })}</b>{' '}
            {t('tools.replace.text')}
          </span>
          <span className="pt-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                pt.keepInstalled();
              }}
            >
              {t('tools.replace.no')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              data-testid="tools-replace-yes"
              onClick={() => void pt.install(replace.path, true)}
            >
              {t('tools.replace.yes', { version: replace.version })}
            </button>
          </span>
        </div>
      )}
      {error && (
        <p className="prov-err" role="alert" data-testid="tools-error">
          {error}
        </p>
      )}
      {note && (
        <p className="notice ok" role="status" data-testid="tools-note">
          <Icon name="check" size={14} />
          {note.kind === 'installed'
            ? t('tools.installed', { version: note.version })
            : t('tools.removed', { name: note.name })}
        </p>
      )}
    </div>
  );
}

function OtherPack({ pack, disabled }: { pack: InstalledPack; disabled: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    await processingTools.getState().remove(pack.name);
    setBusy(false);
    setConfirm(false);
  };
  return (
    <tr data-testid={`tools-pack-${pack.version}`}>
      <td>
        <div className="cell-h">
          <Icon name="layers" size={14} className="faint" />
          <b className="hi mono">{pack.version}</b>
          {!pack.valid && <span className="tag">{t('tools.others.incomplete')}</span>}
        </div>
      </td>
      <td className="mono faint pt-dir" title={pack.dir}>
        {pack.dir}
      </td>
      <td className="mono nowrap">{formatBytes(pack.bytes)}</td>
      <td className="nowrap pack-acts">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn sm danger"
              data-testid={`tools-remove-confirm-${pack.version}`}
              disabled={busy}
              onClick={() => void remove()}
            >
              {t('tools.others.confirm', { version: pack.version })}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t('tools.others.keep')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            data-testid={`tools-remove-${pack.version}`}
            disabled={disabled}
            onClick={() => {
              setConfirm(true);
            }}
          >
            {t('tools.others.remove')}
          </button>
        )}
      </td>
    </tr>
  );
}

function OtherPacks({ packs, disabled }: { packs: InstalledPack[]; disabled: boolean }) {
  if (packs.length === 0) return null;
  return (
    <div className="sblock" data-testid="tools-others">
      <h2>
        {t('tools.others.title')}{' '}
        <span className="sub">{formatBytes(packs.reduce((n, p) => n + p.bytes, 0))}</span>
      </h2>
      <p className="help">{t('tools.others.help')}</p>
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('tools.others.pack')}</th>
            <th>{t('tools.location')}</th>
            <th>{t('tools.size')}</th>
            <th aria-label={t('tools.others.actions')} />
          </tr>
        </thead>
        <tbody>
          {packs.map((p) => (
            <OtherPack key={p.name} pack={p} disabled={disabled} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProcessingTools() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const status = useProcessingTools((s) => s.status);
  const installing = useProcessingTools((s) => s.installing);
  const heading = useRef<HTMLHeadingElement>(null);
  // the data folder holds the packs: read again when it changes
  useEffect(() => {
    void processingTools.getState().load();
  }, [dataRoot]);
  // opened through openProcessingTools(): the heading takes the focus
  const asked = useShell((s) => s.settingsPage === 'tools');
  useEffect(() => {
    if (asked) heading.current?.focus();
  }, [asked]);
  return (
    <>
      <div className="sblock processing-tools" data-testid="processing-tools">
        <h2 ref={heading} tabIndex={-1}>
          {t('tools.title')} <span className="sub">{t('tools.sub')}</span>
        </h2>
        <p className="help">{t('tools.how', { product: brand.productName })}</p>
        <Status status={status} />
        <Install />
      </div>
      {/* a development pack is not ours to manage: its folders are left alone */}
      {status && status.state !== 'dev' && (
        <OtherPacks packs={status.others} disabled={installing} />
      )}
    </>
  );
}
