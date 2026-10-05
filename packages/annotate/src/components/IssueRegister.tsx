import type { Issue, IssueStatus } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { STATUS_ORDER, type Severity } from '../model/ops';
import {
  filterIssues,
  issueDatasets,
  severityCounts,
  sortIssues,
  type DatasetKind,
  type IssueSortKey,
} from '../model/query';
import {
  createSearch,
  flattenGroups,
  groupIssues,
  rowWindow,
  type IssueGroupKey,
  type RegisterRow,
} from '../model/register';
import { focusIssue, issueEditor, useAnnotateReadOnly, useIssueEditorState } from '../runtime';
import { severityColor } from '../tools/mesh';
import { SeverityBadge, kindLabel, sevStyle, useTaxonomy } from './common';
import { AnnotateStyles } from './styles';

const DATASETS: DatasetKind[] = ['mesh', 'image', 'video', 'pointcloud', 'map', 'pano'];
const GROUPS: { key: IssueGroupKey; label: string }[] = [
  { key: 'none', label: 'No grouping' },
  { key: 'severity', label: 'By severity' },
  { key: 'class', label: 'By class' },
  { key: 'zone', label: 'By zone' },
  { key: 'status', label: 'By status' },
];
/** Fixed row heights keep the virtual list exact (see `.ann-row` and `.ann-group`). */
const ROW_H = 48;
const HEAD_H = 30;
/** Height assumed before the list is measured (and in tests without layout). */
const FALLBACK_VIEWPORT = 600;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for issue edits, outside text fields. */
function useUndoHotkeys() {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        if (issueEditor.undo()) e.preventDefault();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        if (issueEditor.redo()) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

export function SaveIndicator() {
  const { save } = useIssueEditorState();
  const text =
    save.state === 'saved'
      ? 'Saved'
      : save.state === 'pending'
        ? 'Unsaved'
        : save.state === 'saving'
          ? 'Saving'
          : 'Not saved';
  return (
    <span className="ann-save" data-state={save.state} title={save.error ?? text} role="status">
      <i />
      {text}
    </span>
  );
}

/** Scroll position and height of the list element, for the virtual row window. */
function useViewport(ref: React.RefObject<HTMLDivElement | null>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_VIEWPORT);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      setHeight(el.clientHeight || FALLBACK_VIEWPORT);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
  return { scrollTop, height, setScrollTop };
}

/**
 * Issue register for thousands of issues: a virtual list (only rows in view exist), indexed
 * search, filters, sort with direction, grouping by severity, class, zone or status, and bulk
 * actions on checked issues (status, class, merge duplicates), each one undo step. Selecting
 * an issue selects it in every view. In a read-only package (player mode) the register only
 * browses: no checkboxes, bulk actions, undo or save state. Owner: stream S7.
 */
export function IssueRegister({ className }: { className?: string }) {
  useUndoHotkeys();
  const issues = useWorkspace((s) => s.issues);
  const selection = useWorkspace((s) => s.selection);
  const { classById, modelById, classes } = useTaxonomy();
  const editor = useIssueEditorState();
  const readOnly = useAnnotateReadOnly();
  const [text, setText] = useState('');
  const query = useDeferredValue(text);
  const [sev, setSev] = useState<Severity | null>(null);
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState<IssueStatus | ''>('');
  const [dataset, setDataset] = useState<DatasetKind | ''>('');
  const [sort, setSort] = useState<IssueSortKey>('code');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [groupBy, setGroupBy] = useState<IssueGroupKey>('none');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const view = useViewport(listRef);

  const selectedId = selection?.kind === 'issue' ? selection.id : null;
  const label = (id: string) => classById.get(id)?.label ?? id;

  const counts = useMemo(() => severityCounts(issues), [issues]);
  const sevKeys = useMemo(
    () =>
      [...counts.keys()].sort((a, b) => (a === 'uncertain' ? 1 : b === 'uncertain' ? -1 : b - a)),
    [counts],
  );
  const firstModel = issues[0] ? modelById.get(issues[0].severityModelId) : undefined;

  const search = useMemo(() => createSearch((id) => classById.get(id)?.label ?? id), [classById]);
  const shown = useMemo(
    () =>
      sortIssues(
        search(
          filterIssues(issues, {
            ...(sev !== null ? { severities: [sev] } : {}),
            ...(classId ? { classIds: [classId] } : {}),
            ...(status ? { statuses: [status] } : {}),
            ...(dataset ? { datasets: [dataset] } : {}),
          }),
          query,
        ),
        sort,
        dir,
      ),
    [issues, search, query, sev, classId, status, dataset, sort, dir],
  );
  const groups = useMemo(
    () => groupIssues(shown, groupBy, (id) => classById.get(id)?.label ?? id),
    [shown, groupBy, classById],
  );
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  const win = rowWindow(rows, {
    scrollTop: view.scrollTop,
    viewport: view.height,
    rowH: ROW_H,
    headH: HEAD_H,
  });

  // checked issues that are gone (merged, deleted) no longer count
  const live = useMemo(() => {
    if (readOnly) return new Set<string>();
    if (!checked.size) return checked;
    const ids = new Set(issues.map((i) => i.id));
    const next = new Set([...checked].filter((id) => ids.has(id)));
    return next.size === checked.size ? checked : next;
  }, [checked, issues, readOnly]);

  // keep the selected issue in view
  useEffect(() => {
    const el = listRef.current;
    if (!selectedId || !el) return;
    const k = rows.findIndex((r) => r.kind === 'issue' && r.issue.id === selectedId);
    if (k < 0) return;
    const top = win.offsetOf(k);
    const h = el.clientHeight || FALLBACK_VIEWPORT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + h) el.scrollTop = top + ROW_H - h;
    view.setScrollTop(el.scrollTop);
    // only when the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const shownIds = useMemo(() => shown.map((i) => i.id), [shown]);
  const allChecked = shownIds.length > 0 && shownIds.every((id) => live.has(id));

  const toggle = (id: string, e: Pick<MouseEvent, 'shiftKey'>) => {
    if (readOnly) return;
    setChecked((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && anchor) {
        const a = shownIds.indexOf(anchor);
        const b = shownIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (const x of shownIds.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const report = (what: string, r: { changed: number; skipped: { code: string }[] }) => {
    const skipped = r.skipped.length
      ? `; ${r.skipped.length} left as they were (${r.skipped
          .slice(0, 4)
          .map((s) => s.code)
          .join(', ')}${r.skipped.length > 4 ? ', ...' : ''})`
      : '';
    setNotice(`${what} ${r.changed} issue${r.changed === 1 ? '' : 's'}${skipped}. Ctrl+Z undoes.`);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!shown.length) return;
    const i = shown.findIndex((x) => x.id === selectedId);
    let next: Issue | undefined;
    if (e.key === 'ArrowDown' || e.key === 'j') next = shown[Math.min(shown.length - 1, i + 1)];
    else if (e.key === 'ArrowUp' || e.key === 'k') next = shown[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = shown[0];
    else if (e.key === 'End') next = shown[shown.length - 1];
    else if (e.key === 'Enter' && i >= 0) next = shown[i];
    else if (e.key === ' ' && selectedId && !readOnly) {
      e.preventDefault();
      toggle(selectedId, e);
      return;
    }
    if (next) {
      e.preventDefault();
      focusIssue(next);
    }
  };

  const renderRow = (r: RegisterRow) => {
    if (r.kind === 'group') {
      const open = !collapsed.has(r.key);
      return (
        <button
          key={`g:${r.key}`}
          type="button"
          className="ann-group"
          aria-expanded={open}
          onClick={() => {
            setCollapsed((cur) => {
              const next = new Set(cur);
              if (next.has(r.key)) next.delete(r.key);
              else next.add(r.key);
              return next;
            });
          }}
        >
          <span className="car" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <span className="ann-dot" style={sevStyle(severityColor(firstModel, r.top))} />
          <span className="gl">{r.label}</span>
          <span className="gc">{r.count}</span>
        </button>
      );
    }
    const i = r.issue;
    const on = live.has(i.id);
    return (
      <div
        key={i.id}
        data-id={i.id}
        role="option"
        aria-selected={i.id === selectedId}
        className={`ann-row${i.status === 'draft' ? ' draft' : ''}${on ? ' checked' : ''}${readOnly ? ' ro' : ''}`}
        onClick={(e) => {
          if (!readOnly && (e.ctrlKey || e.metaKey)) {
            toggle(i.id, e);
            return;
          }
          focusIssue(i);
        }}
      >
        {!readOnly && (
          <input
            type="checkbox"
            className="ann-tick"
            aria-label={`Select ${i.code}`}
            checked={on}
            onClick={(e) => {
              e.stopPropagation();
              toggle(i.id, e);
            }}
            onChange={() => undefined}
          />
        )}
        <span className="iid">{i.code}</span>
        <span className="it">{i.title}</span>
        <SeverityBadge model={modelById.get(i.severityModelId)} severity={i.severity} />
        <span className="im">
          {label(i.classId)} · {issueDatasets(i).map(kindLabel).join(', ')} ·{' '}
          <span className="st">{i.status}</span>
        </span>
      </div>
    );
  };

  return (
    <div className={`ann-panel ${className ?? ''}`} data-testid="issue-register">
      <AnnotateStyles />
      <div className="ann-h">
        <h3>Issues</h3>
        <span className="sub">
          {shown.length === issues.length ? issues.length : `${shown.length} of ${issues.length}`}
        </span>
        <div className="acts">
          {readOnly ? (
            <span className="ann-tag" title="Opened from a read-only package">
              Read-only
            </span>
          ) : (
            <>
              <SaveIndicator />
              <button
                type="button"
                className="ann-btn ghost"
                disabled={!editor.canUndo}
                title={editor.undoLabel ? `Undo ${editor.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
                onClick={() => issueEditor.undo()}
              >
                Undo
              </button>
              <button
                type="button"
                className="ann-btn ghost"
                disabled={!editor.canRedo}
                title={editor.redoLabel ? `Redo ${editor.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
                onClick={() => issueEditor.redo()}
              >
                Redo
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ann-filter">
        <div className="ann-seg" role="group" aria-label="Severity filter">
          <button
            type="button"
            aria-pressed={sev === null}
            onClick={() => {
              setSev(null);
            }}
          >
            All
          </button>
          {sevKeys.map((k) => (
            <button
              key={String(k)}
              type="button"
              aria-pressed={sev === k}
              title={k === 'uncertain' ? 'Uncertain' : `Severity ${k}`}
              onClick={() => {
                setSev(sev === k ? null : k);
              }}
            >
              <span className="ann-dot" style={sevStyle(severityColor(firstModel, k))} />
              {counts.get(k)}
            </button>
          ))}
        </div>
        <input
          className="ann-input grow"
          type="search"
          placeholder="Search code, title, note"
          aria-label="Search issues"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      </div>
      <div className="ann-filter">
        <select
          className="ann-select"
          aria-label="Class"
          value={classId}
          onChange={(e) => {
            setClassId(e.target.value);
          }}
        >
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className="ann-select"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as IssueStatus | '');
          }}
        >
          <option value="">Any status</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="ann-select"
          aria-label="Dataset"
          value={dataset}
          onChange={(e) => {
            setDataset(e.target.value as DatasetKind | '');
          }}
        >
          <option value="">Any dataset</option>
          {DATASETS.map((d) => (
            <option key={d} value={d}>
              {kindLabel(d)}
            </option>
          ))}
        </select>
        <select
          className="ann-select"
          aria-label="Sort"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as IssueSortKey);
          }}
        >
          <option value="code">Code</option>
          <option value="severity">Severity</option>
          <option value="status">Status</option>
          <option value="updated">Last change</option>
          <option value="class">Class</option>
        </select>
        <button
          type="button"
          className="ann-btn ghost ann-dir"
          aria-label={dir === 'asc' ? 'Reverse the sort order' : 'Natural sort order'}
          title={dir === 'asc' ? 'Reverse the sort order' : 'Natural sort order'}
          aria-pressed={dir === 'desc'}
          onClick={() => {
            setDir(dir === 'asc' ? 'desc' : 'asc');
          }}
        >
          {dir === 'asc' ? '↓' : '↑'}
        </button>
        <select
          className="ann-select"
          aria-label="Group"
          value={groupBy}
          onChange={(e) => {
            setGroupBy(e.target.value as IssueGroupKey);
            setCollapsed(new Set());
          }}
        >
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {!readOnly && (
        <div className="ann-bulk" data-active={live.size > 0}>
          <input
            type="checkbox"
            className="ann-tick"
            aria-label="Select all shown"
            title="Select every issue the filters show"
            checked={allChecked}
            disabled={!shownIds.length}
            onChange={() => {
              setChecked(allChecked ? new Set() : new Set(shownIds));
              setNotice(null);
            }}
          />
          {live.size > 0 ? (
            <>
              <span className="cnt">{live.size} selected</span>
              <select
                className="ann-select"
                aria-label="Set status"
                value=""
                onChange={(e) => {
                  const to = e.target.value as IssueStatus | '';
                  if (!to) return;
                  report(`Set to ${to}:`, issueEditor.setStatusMany([...live], to));
                }}
              >
                <option value="">Set status</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                className="ann-select"
                aria-label="Set class"
                value=""
                onChange={(e) => {
                  const to = e.target.value;
                  if (!to) return;
                  report(`Set to ${label(to)}:`, issueEditor.setClassMany([...live], to));
                }}
              >
                <option value="">Set class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ann-btn"
                aria-label="Merge selected"
                title="Merge the selected issues into the most severe one (their sightings join it)"
                disabled={live.size < 2}
                onClick={() => {
                  const r = issueEditor.mergeMany([...live]);
                  if (r.ok) {
                    setChecked(new Set([r.value.id]));
                    setNotice(`Merged into ${r.value.code}. Ctrl+Z undoes.`);
                  } else setNotice(r.error);
                }}
              >
                Merge
              </button>
              <button
                type="button"
                className="ann-btn ghost"
                onClick={() => {
                  setChecked(new Set());
                  setNotice(null);
                }}
              >
                Clear
              </button>
            </>
          ) : (
            <span className="ann-faint">
              {notice ?? 'Check issues (Shift for a range) for bulk status, class or merge.'}
            </span>
          )}
        </div>
      )}
      {live.size > 0 && notice && <div className="ann-notice">{notice}</div>}
      <div
        ref={listRef}
        className="ann-list"
        data-issue-list
        role="listbox"
        aria-label="Issues"
        aria-multiselectable={!readOnly}
        tabIndex={0}
        onKeyDown={onKey}
      >
        {shown.length === 0 && (
          <div className="ann-empty">
            {issues.length > 0
              ? 'No issue matches the filters.'
              : readOnly
                ? 'This package has no issues.'
                : 'No issues yet. Draw on a photo, a video frame or the model to add one.'}
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ height: win.total, position: 'relative' }}>
            <div style={{ transform: `translateY(${win.padTop}px)` }}>
              {rows.slice(win.start, win.end).map(renderRow)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
