import {
  DEFAULT_PACKAGE_EXPORTS,
  type ExportKind,
  type IpcEvent,
  type PackagePlan,
} from '@aio/schema';
import { formatBytes, Icon, Switch } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { EXPORT_CHOICES, groupLayers, toggleGroup, validatePassphrase } from '../packageModel';
import { bridge, shell, useShell } from '../shell';

type Phase =
  | { kind: 'setup' }
  | { kind: 'running'; jobId: string; progress: IpcEvent<'package:progress'> | null }
  | { kind: 'done'; path: string; bytes: number | undefined }
  | { kind: 'error'; message: string };

const newJobId = () => `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Export the open project as a `.aio` package (BLD-9): layers, policy, encryption, size. */
export function PackageExportDialog() {
  const projectId = useShell((s) => s.exportFor);
  const project = useWorkspace((s) => s.project);
  if (!projectId || project?.id !== projectId) return null;
  return <ExportForm key={projectId} projectId={projectId} name={project.manifest.name} />;
}

function ExportForm({ projectId, name }: { projectId: string; name: string }) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<PackagePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(true);
  const [allowAi, setAllowAi] = useState(false);
  const [exportsAllowed, setExportsAllowed] = useState<Set<ExportKind>>(
    new Set(DEFAULT_PACKAGE_EXPORTS),
  );
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });

  const excludeKey = [...excluded].sort().join('|');
  useEffect(() => {
    let live = true;
    void bridge.call('package:plan', { projectId, exclude: [...excluded] }).then((r) => {
      if (!live) return;
      if (!r.ok) setPlanError(r.error);
      else if (!r.value.ok) setPlanError(r.value.error);
      else {
        setPlan(r.value.plan);
        setPlanError(null);
      }
    });
    return () => {
      live = false;
    };
    // excludeKey stands for `excluded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, excludeKey]);

  const running = phase.kind === 'running' ? phase.jobId : null;
  useEffect(() => {
    if (!running) return;
    return window.aio.on('package:progress', (p) => {
      if (p.jobId !== running) return;
      setPhase((cur) => (cur.kind === 'running' ? { ...cur, progress: p } : cur));
    });
  }, [running]);

  const groups = useMemo(() => groupLayers(plan?.layers ?? [], excluded), [plan, excluded]);
  const passError = encrypt ? validatePassphrase(pass, again) : null;
  const tooBig = plan?.freeBytes !== undefined && plan.totalBytes > plan.freeBytes;
  const close = () => {
    if (phase.kind !== 'running') shell.getState().setExportFor(null);
  };

  const start = async () => {
    if (passError) return;
    const jobId = newJobId();
    setPhase({ kind: 'running', jobId, progress: null });
    const welcome = message.trim();
    const r = await bridge.call('package:export', {
      jobId,
      options: {
        projectId,
        exclude: [...excluded],
        readOnly,
        aiPolicy: allowAi ? 'allow' : 'forbid',
        exports: EXPORT_CHOICES.map((c) => c.kind).filter((k) => exportsAllowed.has(k)),
        ...(encrypt ? { passphrase: pass } : {}),
        ...(welcome ? { welcome: { message: welcome } } : {}),
      },
    });
    if (!r.ok) setPhase({ kind: 'error', message: r.error });
    else if (!r.value.ok) setPhase({ kind: 'error', message: r.value.error });
    else if (r.value.path === null) setPhase({ kind: 'setup' });
    else setPhase({ kind: 'done', path: r.value.path, bytes: r.value.bytes });
  };

  const progress = phase.kind === 'running' ? phase.progress : null;
  const pct = progress && progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0;

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="dlg wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pkg-title"
        data-testid="package-export"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name="download" size={16} />
          <h2 id="pkg-title">Export package</h2>
          <span className="sub">{name}</span>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label="Close"
            disabled={phase.kind === 'running'}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="dlg-b">
          <section className="dlg-sec">
            <h3 className="caps">Layers</h3>
            <p>
              One <code>.aio</code> file, uncompressed so clips and clouds stream straight from it.
              Leave out what the customer does not need.
            </p>
            {planError && (
              <p className="notice danger" role="alert">
                <Icon name="warn" size={14} />
                {planError}
              </p>
            )}
            <div className="pkg-layers" aria-busy={plan === null}>
              {groups.map((g) => (
                <label key={g.kind} className={`pkg-layer${g.state === 'none' ? ' off' : ''}`}>
                  <input
                    type="checkbox"
                    checked={g.state !== 'none'}
                    ref={(el) => {
                      if (el) el.indeterminate = g.state === 'some';
                    }}
                    disabled={phase.kind === 'running'}
                    onChange={() => {
                      setExcluded((ex) => toggleGroup(ex, plan?.layers ?? [], g.kind));
                    }}
                    data-testid={`pkg-group-${g.kind}`}
                  />
                  <Icon name={groupIcon(g.kind)} size={14} />
                  <span>{g.label}</span>
                  <span className="n">
                    {g.count} {g.count === 1 ? 'layer' : 'layers'}
                  </span>
                  <span className="mono">{formatBytes(g.bytes)}</span>
                </label>
              ))}
              {plan && (
                <div className="pkg-layer">
                  <span />
                  <Icon name="issues" size={14} />
                  <span>Issues, report, thumbnail</span>
                  <span className="n">always</span>
                  <span className="mono">{formatBytes(plan.baseBytes)}</span>
                </div>
              )}
            </div>
          </section>

          <section className="pkg-size" aria-label="Size report" data-testid="pkg-size">
            <div>
              <b>{plan ? formatBytes(plan.totalBytes) : '...'}</b>
              <span>Package size</span>
            </div>
            <div>
              <b>{plan ? String(plan.totalFiles) : '...'}</b>
              <span>Files</span>
            </div>
            <div className={tooBig ? 'warn' : ''}>
              <b>{plan?.freeBytes !== undefined ? formatBytes(plan.freeBytes) : 'Unknown'}</b>
              <span>{tooBig ? 'Free: not enough on this drive' : 'Free on this drive'}</span>
            </div>
          </section>

          <section className="dlg-sec">
            <h3 className="caps">Customer policy</h3>
            <div className="pkg-row">
              <span>Read-only player: no annotation, no issue edits</span>
              <Switch checked={readOnly} label="Read-only player" onChange={setReadOnly} />
            </div>
            <div className="pkg-row">
              <span>Allow cloud AI with this package (off: never sent to any provider)</span>
              <Switch checked={allowAi} label="Allow cloud AI" onChange={setAllowAi} />
            </div>
            <p style={{ marginTop: 8 }}>The customer may save:</p>
            <div className="pkg-opts">
              {EXPORT_CHOICES.map((c) => (
                <label key={c.kind} className="pkg-check">
                  <input
                    type="checkbox"
                    checked={exportsAllowed.has(c.kind)}
                    onChange={() => {
                      setExportsAllowed((cur) => {
                        const next = new Set(cur);
                        if (next.has(c.kind)) next.delete(c.kind);
                        else next.add(c.kind);
                        return next;
                      });
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </section>

          <section className="dlg-sec">
            <div className="pkg-row">
              <span>Encrypt with a passphrase (AES-256)</span>
              <Switch checked={encrypt} label="Encrypt" onChange={setEncrypt} />
            </div>
            {encrypt && (
              <>
                <div className="pkg-pass">
                  <input
                    className="input"
                    type="password"
                    placeholder="Passphrase"
                    aria-label="Passphrase"
                    value={pass}
                    onChange={(e) => {
                      setPass(e.target.value);
                    }}
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="Type it again"
                    aria-label="Repeat passphrase"
                    value={again}
                    onChange={(e) => {
                      setAgain(e.target.value);
                    }}
                  />
                </div>
                <p style={{ marginTop: 6 }}>
                  {passError ??
                    'Send the passphrase separately. It cannot be recovered from the package.'}
                </p>
              </>
            )}
          </section>

          <section className="dlg-sec">
            <h3 className="caps">Welcome note</h3>
            <textarea
              className="input"
              placeholder="Optional message on the customer's welcome screen"
              maxLength={2000}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
              }}
            />
          </section>

          {phase.kind === 'running' && (
            <section className="pkg-progress" aria-live="polite" data-testid="pkg-progress">
              <div className="track">
                <i style={{ width: `${String(Math.round(pct * 100))}%` }} />
              </div>
              <div className="meta">
                <span className="mono">
                  {progress
                    ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)} · ${String(progress.filesDone)} of ${String(progress.filesTotal)} files`
                    : 'Starting'}
                </span>
                <span className="cur">{progress?.current ?? ''}</span>
              </div>
            </section>
          )}
          {phase.kind === 'done' && (
            <p className="notice" role="status" data-testid="pkg-done">
              <Icon name="check" size={14} />
              <span>
                <b>Package written.</b> {phase.path}
                {phase.bytes !== undefined ? ` (${formatBytes(phase.bytes)})` : ''}
              </span>
            </p>
          )}
          {phase.kind === 'error' && (
            <p className="notice danger" role="alert">
              <Icon name="warn" size={14} />
              {phase.message}
            </p>
          )}
        </div>

        <div className="dlg-f">
          <span className="grow faint small">
            {readOnly ? 'Customer package' : 'Working package'} ·{' '}
            {allowAi ? 'cloud AI allowed' : 'cloud AI forbidden'}
            {encrypt ? ' · encrypted' : ''}
          </span>
          {phase.kind === 'running' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void bridge.call('package:cancel', { jobId: phase.jobId });
              }}
            >
              Cancel export
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={close}>
                {phase.kind === 'done' ? 'Close' : 'Cancel'}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={plan === null || passError !== null || tooBig}
                onClick={() => void start()}
                data-testid="pkg-export"
              >
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function groupIcon(kind: string) {
  switch (kind) {
    case 'mesh':
      return 'scene' as const;
    case 'pointcloud':
      return 'cloud' as const;
    case 'video':
      return 'video' as const;
    case 'photos':
      return 'photo' as const;
    case 'panoramas':
      return 'pano' as const;
    case 'raster':
    case 'basemap':
      return 'raster' as const;
    default:
      return 'history' as const;
  }
}
