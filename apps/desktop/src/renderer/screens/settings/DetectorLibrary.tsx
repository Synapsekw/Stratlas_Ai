/**
 * Settings, Processing tools, Detector library: the detectors on this computer in three groups
 * (Shipped with the Analytics pack, My library, This project), each with its hit rate from the
 * local review ledger. **Import** adds a `.aiodet` to My library (an id already there offers
 * Update or Keep both), Export writes one (optionally without its sample photos), and Remove and
 * Clear review history ask inline first. Shipped detectors come and go with the pack and cannot
 * be removed here.
 */
import type { DetectorWhere, IpcRequest, IpcResponse } from '@aio/schema';
import { Chip, Icon, t, Tip, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnalyticsPack } from '../../analyticsPack';
import { ModelMismatchMark } from '../../detections/detectors/ModelMismatchMark';
import type { Res } from '../../bridge';
import { bridge } from '../../shell';
import './detectorLibrary.css';

type Item = IpcResponse<'detectors:list'>['items'][number];
type Stats = IpcResponse<'ledger:stats'>;
type ImportRequest = IpcRequest<'detectors:import'>;
/** An id already in My library, and the request that reads the same file again. */
interface Conflict {
  id: string;
  have: number;
  incoming: number;
  again: ImportRequest;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

const GROUPS: { where: DetectorWhere; label: MessageKey }[] = [
  { where: 'shipped', label: 'detect.preset.library.shipped' },
  { where: 'library', label: 'detect.preset.library.library' },
  { where: 'project', label: 'detect.preset.library.project' },
];

/** accepted / (accepted + rejected); null before any verdict. */
export function hitRate(s: Pick<Stats, 'accepted' | 'rejected'>): number | null {
  const judged = s.accepted + s.rejected;
  return judged === 0 ? null : s.accepted / judged;
}

const hasReviews = (s: Stats) => s.accepted + s.rejected + s.misses > 0;

/** "75% hit rate · 12 reviewed · 2 missed · suggested threshold 0.85", or "No reviews yet". */
function statsText(s: Stats): string {
  if (!hasReviews(s)) return t('detect.preset.library.noReviews');
  const rate = hitRate(s);
  const parts: string[] = [];
  if (rate !== null)
    parts.push(t('detect.preset.library.hitRate', { pct: Math.round(rate * 100) }));
  parts.push(t('detect.preset.library.reviewed', { n: s.accepted + s.rejected }));
  if (s.misses > 0) parts.push(t('detect.preset.library.missed', { n: s.misses }));
  if (s.suggestedThreshold !== null) {
    parts.push(t('detect.preset.library.suggested', { value: s.suggestedThreshold.toFixed(2) }));
  }
  return parts.join(' · ');
}

async function readStats(detectorId: string): Promise<Stats | null> {
  const r = await bridge.call('ledger:stats', { detectorId });
  return r.ok ? r.value : null;
}

/** At most this many `ledger:stats` reads at once. */
const STATS_AT_ONCE = 4;

async function readAllStats(ids: string[]): Promise<Map<string, Stats | null>> {
  const out = new Map<string, Stats | null>();
  let next = 0;
  const worker = async () => {
    for (let id = ids[next++]; id !== undefined; id = ids[next++]) {
      out.set(id, await readStats(id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATS_AT_ONCE, ids.length) }, worker));
  return out;
}

/** What the section shows, for the project it was read with. */
interface Library {
  projectId: string | null;
  items: Item[];
  stats: ReadonlyMap<string, Stats | null>;
}

interface Failed {
  projectId: string | null;
  error: string;
}

/** The detectors (the project's too when one is open) and each one's review stats. */
async function readLibrary(projectId: string | null): Promise<Library | Failed> {
  const r = await bridge.call('detectors:list', projectId === null ? {} : { projectId });
  if (!r.ok) return { projectId, error: r.error };
  const stats = await readAllStats([...new Set(r.value.items.map((i) => i.detector.id))]);
  return { projectId, items: r.value.items, stats };
}

/** The error of an `Ok`-shaped answer, null when it worked. */
function failure(r: Res<{ ok: boolean; error?: string | undefined }>): string | null {
  if (r.ok && r.value.ok) return null;
  const error = r.ok ? r.value.error : r.error;
  return error === undefined || error.trim() === '' ? t('detect.preset.library.failed') : error;
}

/** The project id is sent only for a project detector. */
function at(where: DetectorWhere, projectId: string | null): { projectId?: string } {
  return where === 'project' && projectId !== null ? { projectId } : {};
}

interface RowProps {
  item: Item;
  stats: Stats | null | undefined;
  projectId: string | null;
  onRemoved: () => Promise<void>;
  onCleared: (id: string) => Promise<void>;
  onNote: (text: string) => void;
  onError: (text: string) => void;
}

function DetectorRow({ item, stats, projectId, onRemoved, onCleared, onNote, onError }: RowProps) {
  const { where, detector: d } = item;
  const [open, setOpen] = useState<'export' | 'remove' | 'clear' | null>(null);
  const [leaveOut, setLeaveOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    await work();
    setBusy(false);
    setOpen(null);
  };
  const exportIt = () =>
    run(async () => {
      const r = await bridge.call('detectors:export', {
        where,
        ...at(where, projectId),
        id: d.id,
        includeSamples: !leaveOut,
      });
      if (!r.ok) onError(r.error);
      else if (r.value.ok)
        onNote(t('detect.preset.library.exported', { file: fileName(r.value.path) }));
      else if (!r.value.cancelled) onError(r.value.error);
    });
  const remove = () =>
    run(async () => {
      if (where === 'shipped') return;
      const r = await bridge.call('detectors:remove', { where, ...at(where, projectId), id: d.id });
      const error = failure(r);
      if (error !== null) onError(error);
      else await onRemoved();
    });
  const clear = () =>
    run(async () => {
      const r = await bridge.call('ledger:clear', { detectorId: d.id });
      const error = failure(r);
      if (error !== null) onError(error);
      else await onCleared(d.id);
    });
  const confirm = (label: string, testid: string, act: () => Promise<void>) => (
    <>
      <button
        type="button"
        className="btn sm danger"
        data-testid={testid}
        disabled={busy}
        onClick={() => void act()}
      >
        {label}
      </button>
      <button
        type="button"
        className="btn sm ghost"
        disabled={busy}
        onClick={() => {
          setOpen(null);
        }}
      >
        {t('detect.preset.library.keep')}
      </button>
    </>
  );
  return (
    <>
      <tr data-testid={`dl-row-${where}-${d.id}`}>
        <td>
          <div className="cell-h dl-name">
            <b className="hi">{d.name}</b>
            <span className="mono faint">
              {t('detect.preset.library.version', { version: d.version })}
            </span>
            {d.status === 'experimental' && (
              <Chip kind="status" tone="warn">
                {t('detect.preset.library.experimental')}
              </Chip>
            )}
            {item.modelMismatch && <ModelMismatchMark testId={`dl-mismatch-${d.id}`} />}
          </div>
        </td>
        <td className="dl-stats" data-testid={`dl-stats-${d.id}`}>
          {stats ? statsText(stats) : t('detect.preset.library.statsFailed')}
        </td>
        <td className="nowrap pack-acts">
          {open === 'remove' &&
            confirm(
              t('detect.preset.library.removeConfirm', { name: d.name }),
              `dl-remove-yes-${d.id}`,
              remove,
            )}
          {open === 'clear' &&
            confirm(t('detect.preset.library.clearConfirm'), `dl-clear-yes-${d.id}`, clear)}
          {open !== 'remove' && open !== 'clear' && (
            <>
              {stats && hasReviews(stats) && (
                <button
                  type="button"
                  className="btn sm ghost"
                  data-testid={`dl-clear-${d.id}`}
                  onClick={() => {
                    setOpen('clear');
                  }}
                >
                  {t('detect.preset.library.clear')}
                </button>
              )}
              <button
                type="button"
                className="btn sm ghost"
                data-testid={`dl-export-${d.id}`}
                aria-expanded={open === 'export'}
                onClick={() => {
                  setOpen(open === 'export' ? null : 'export');
                }}
              >
                {t('detect.preset.library.export')}
              </button>
              {where !== 'shipped' && (
                <button
                  type="button"
                  className="btn sm ghost"
                  data-testid={`dl-remove-${d.id}`}
                  onClick={() => {
                    setOpen('remove');
                  }}
                >
                  {t('detect.preset.library.remove')}
                </button>
              )}
            </>
          )}
        </td>
      </tr>
      {open === 'export' && (
        <tr className="dl-sub">
          <td colSpan={3}>
            <div className="dl-export" data-testid="dl-export-panel">
              <label className="dl-check">
                <input
                  type="checkbox"
                  checked={leaveOut}
                  onChange={(e) => {
                    setLeaveOut(e.currentTarget.checked);
                  }}
                />
                {t('detect.preset.library.leaveOut')}
              </label>
              <span className="dl-acts">
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => {
                    setOpen(null);
                  }}
                >
                  {t('detect.preset.library.cancel')}
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  data-testid="dl-export-go"
                  disabled={busy}
                  onClick={() => void exportIt()}
                >
                  {t('detect.preset.library.exportGo')}
                </button>
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function DetectorLibrary() {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  // shipped detectors come with the pack: none without it
  const packVersion = useAnalyticsPack((s) => s.status?.installed?.version ?? null);
  const [library, setLibrary] = useState<Library | null>(null);
  // rows read for another project are never shown, so they cannot act with this project's id
  const shown = library?.projectId === projectId ? library : null;
  /** The project open now: an answer read for another one is dropped. */
  const current = useRef(projectId);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const apply = useCallback((r: Library | Failed) => {
    if (r.projectId !== current.current) return;
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setError(null);
    setLibrary(r);
  }, []);
  const reload = () => readLibrary(projectId).then(apply);
  const cleared = async (id: string) => {
    const read = projectId;
    const s = await readStats(id);
    if (read !== current.current) return;
    setLibrary((l) => (l?.projectId === read ? { ...l, stats: new Map(l.stats).set(id, s) } : l));
  };
  useEffect(() => {
    current.current = projectId;
    let live = true;
    void readLibrary(projectId).then((r) => {
      if (live) apply(r);
    });
    return () => {
      live = false;
    };
  }, [apply, projectId, packVersion]);

  const say = (text: string) => {
    setError(null);
    setNote(text);
  };
  const fail = (text: string) => {
    setNote(null);
    setError(text);
  };

  const importFile = async (req: ImportRequest = { where: 'library' }) => {
    setImporting(true);
    setConflict(null);
    const r = await bridge.call('detectors:import', req);
    setImporting(false);
    if (!r.ok) {
      fail(r.error);
      return;
    }
    const v = r.value;
    if (v.ok) {
      say(t('detect.preset.library.imported', { id: v.id }));
      await reload();
      return;
    }
    if (v.cancelled) return;
    if (v.conflict) {
      setError(null);
      setNote(null);
      setConflict({
        ...v.conflict,
        again: { where: 'library', ...(v.path === undefined ? {} : { path: v.path }) },
      });
      return;
    }
    fail(v.error);
  };

  const groups = GROUPS.filter(
    (g) =>
      (g.where !== 'shipped' || packVersion !== null) &&
      (g.where !== 'project' || projectId !== null),
  );
  return (
    <div className="sblock dl-section" data-testid="detector-library">
      <h2>
        {t('detect.preset.library.title')}
        <span className="acts">
          <Tip content={t('detect.preset.library.importHint')}>
            <button
              type="button"
              className="btn sm"
              data-testid="dl-import"
              disabled={importing}
              onClick={() => void importFile()}
            >
              <Icon name="import" size={14} />
              {t('detect.preset.library.import')}
            </button>
          </Tip>
        </span>
      </h2>
      <p className="help">{t('detect.preset.library.help')}</p>
      {conflict && (
        <div className="notice warn" role="alert" data-testid="dl-conflict">
          <Icon name="warn" size={14} />
          <span>
            {t('detect.preset.library.conflict', {
              id: conflict.id,
              have: conflict.have,
              incoming: conflict.incoming,
            })}
          </span>
          <span className="dl-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setConflict(null);
              }}
            >
              {t('detect.preset.library.cancel')}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => void importFile({ ...conflict.again, onConflict: 'keep-both' })}
            >
              {t('detect.preset.library.keepBoth')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void importFile({ ...conflict.again, onConflict: 'update' })}
            >
              {t('detect.preset.library.update', { version: conflict.incoming })}
            </button>
          </span>
        </div>
      )}
      {error && (
        <p className="prov-err" role="alert" data-testid="dl-error">
          {error}
        </p>
      )}
      {note && (
        <div className="notice ok" role="status" data-testid="dl-note">
          <Icon name="check" size={14} />
          <span>{note}</span>
        </div>
      )}
      {shown &&
        groups.map((g) => {
          const rows = shown.items.filter((i) => i.where === g.where);
          return (
            <section className="dl-group" key={g.where} data-testid={`dl-group-${g.where}`}>
              <h3>{t(g.label)}</h3>
              {rows.length === 0 ? (
                <p className="help dl-empty">{t('detect.preset.library.empty')}</p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t('detect.preset.library.detector')}</th>
                      <th>{t('detect.preset.library.reviews')}</th>
                      <th aria-label={t('detect.preset.library.actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => (
                      <DetectorRow
                        key={i.detector.id}
                        item={i}
                        stats={shown.stats.get(i.detector.id)}
                        projectId={projectId}
                        onRemoved={reload}
                        onCleared={cleared}
                        onNote={say}
                        onError={fail}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
    </div>
  );
}
