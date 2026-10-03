import type { Issue, IssueStatus } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { STATUS_ORDER, type Severity } from '../model/ops';
import {
  filterIssues,
  issueDatasets,
  severityCounts,
  sortIssues,
  type DatasetKind,
  type IssueSortKey,
} from '../model/query';
import { focusIssue, issueEditor, useIssueEditorState } from '../runtime';
import { severityColor } from '../tools/mesh';
import { SeverityBadge, kindLabel, sevStyle, useTaxonomy } from './common';
import { AnnotateStyles } from './styles';

const DATASETS: DatasetKind[] = ['mesh', 'image', 'video', 'pointcloud', 'map', 'pano'];

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

/**
 * Issue register: issues with code, class, severity (model colours), status and sightings;
 * filter, search, sort; selecting an issue selects it in every view. Owner: stream S7.
 */
export function IssueRegister({ className }: { className?: string }) {
  useUndoHotkeys();
  const issues = useWorkspace((s) => s.issues);
  const selection = useWorkspace((s) => s.selection);
  const { classById, modelById, classes } = useTaxonomy();
  const editor = useIssueEditorState();
  const [text, setText] = useState('');
  const [sev, setSev] = useState<Severity | null>(null);
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState<IssueStatus | ''>('');
  const [dataset, setDataset] = useState<DatasetKind | ''>('');
  const [sort, setSort] = useState<IssueSortKey>('code');
  const listRef = useRef<HTMLDivElement>(null);

  const selectedId = selection?.kind === 'issue' ? selection.id : null;
  const label = (id: string) => classById.get(id)?.label ?? id;

  const counts = useMemo(() => severityCounts(issues), [issues]);
  const sevKeys = useMemo(
    () =>
      [...counts.keys()].sort((a, b) => (a === 'uncertain' ? 1 : b === 'uncertain' ? -1 : b - a)),
    [counts],
  );
  const firstModel = issues[0] ? modelById.get(issues[0].severityModelId) : undefined;

  const shown = useMemo(
    () =>
      sortIssues(
        filterIssues(
          issues,
          {
            text,
            ...(sev !== null ? { severities: [sev] } : {}),
            ...(classId ? { classIds: [classId] } : {}),
            ...(status ? { statuses: [status] } : {}),
            ...(dataset ? { datasets: [dataset] } : {}),
          },
          (id) => classById.get(id)?.label ?? id,
        ),
        sort,
      ),
    [issues, text, sev, classId, status, dataset, sort, classById],
  );

  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!shown.length) return;
    const i = shown.findIndex((x) => x.id === selectedId);
    let next: Issue | undefined;
    if (e.key === 'ArrowDown' || e.key === 'j') next = shown[Math.min(shown.length - 1, i + 1)];
    else if (e.key === 'ArrowUp' || e.key === 'k') next = shown[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = shown[0];
    else if (e.key === 'End') next = shown[shown.length - 1];
    else if (e.key === 'Enter' && i >= 0) next = shown[i];
    if (next) {
      e.preventDefault();
      focusIssue(next);
    }
  };

  return (
    <div className={`ann-panel ${className ?? ''}`} data-testid="issue-register">
      <AnnotateStyles />
      <div className="ann-h">
        <h3>Issues</h3>
        <span className="sub">{issues.length}</span>
        <div className="acts">
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
      </div>
      <div
        ref={listRef}
        className="ann-list"
        role="listbox"
        aria-label="Issues"
        tabIndex={0}
        onKeyDown={onKey}
      >
        {shown.length === 0 && (
          <div className="ann-empty">
            {issues.length === 0
              ? 'No issues yet. Draw on a photo, a video frame or the model to add one.'
              : 'No issue matches the filters.'}
          </div>
        )}
        {shown.map((i) => (
          <div
            key={i.id}
            data-id={i.id}
            role="option"
            aria-selected={i.id === selectedId}
            className={`ann-row${i.status === 'draft' ? ' draft' : ''}`}
            onClick={() => {
              focusIssue(i);
            }}
          >
            <span className="iid">{i.code}</span>
            <span className="it">{i.title}</span>
            <SeverityBadge model={modelById.get(i.severityModelId)} severity={i.severity} />
            <span className="im">
              {label(i.classId)} · {issueDatasets(i).map(kindLabel).join(', ')} ·{' '}
              <span className="st">{i.status}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
