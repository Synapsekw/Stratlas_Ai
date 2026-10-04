import type { Issue, Sighting } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import {
  annotateUi,
  cancelSighting,
  confirmSighting,
  issueEditor,
  useAnnotateUi,
} from '../runtime';
import { severityColor } from '../tools/mesh';
import { sevStyle, useTaxonomy } from './common';
import { AnnotateStyles } from './styles';

/**
 * Class and severity popover for a finished shape. Keyboard: the class hotkey from the catalogue
 * picks the class, then a digit picks the severity (`u` for uncertain); Enter creates the issue,
 * `a` adds the shape to the selected issue, Esc cancels.
 *
 * Mount one per viewer with `kinds` naming the sightings it owns (MapView mounts `['map']`).
 */
export function SightingPicker({ kinds }: { kinds: readonly Sighting['on'][] }) {
  const pending = useAnnotateUi((s) => s.pending);
  const lastClassId = useAnnotateUi((s) => s.lastClassId);
  const lastSeverity = useAnnotateUi((s) => s.lastSeverity);
  const selection = useWorkspace((s) => s.selection);
  const selectedIssue = useWorkspace((s) =>
    selection?.kind === 'issue' ? s.issues.find((i) => i.id === selection.id) : undefined,
  );
  const { classes, models } = useTaxonomy();
  const [classId, setClassId] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Issue['severity'] | null>(null);
  const [stage, setStage] = useState<'class' | 'severity'>('class');
  const [error, setError] = useState<string | null>(null);
  const open = pending !== null && kinds.includes(pending.sighting.on);

  // Reset the form for each new shape (derived during render, not in an effect).
  const [pendingSeen, setPendingSeen] = useState(pending);
  if (pendingSeen !== pending) {
    setPendingSeen(pending);
    setClassId(lastClassId ?? classes[0]?.id ?? null);
    setSeverity(lastSeverity);
    setStage('class');
    setError(null);
  }

  const cls = classes.find((c) => c.id === classId);
  const model = models.find((m) => m.id === cls?.severityModel) ?? models[0];
  const levels: Issue['severity'][] = [
    ...(model?.levels.map((l) => l.value) ?? []),
    ...(model?.uncertain ? (['uncertain'] as const) : []),
  ];

  const confirm = () => {
    if (!classId || severity === null) {
      setError('Pick a class and a severity');
      return;
    }
    const e = confirmSighting(classId, severity);
    setError(e);
  };
  const attach = () => {
    if (!pending || !selectedIssue) return;
    const r = issueEditor.addSighting(selectedIssue.id, pending.sighting);
    if (r.ok) annotateUi.setState({ pending: null });
    else setError(r.error);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        cancelSighting();
      } else if (k === 'enter') {
        confirm();
      } else if (k === 'a' && selectedIssue && stage === 'class') {
        attach();
      } else if (stage === 'class') {
        const hit = classes.find((c) => c.hotkey?.toLowerCase() === k);
        if (!hit) return;
        setClassId(hit.id);
        setStage('severity');
      } else if (k === 'u' && model?.uncertain) {
        setSeverity('uncertain');
      } else if (/^\d$/.test(k) && levels.includes(Number(k))) {
        setSeverity(Number(k));
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  });

  if (!open) return null;
  const at = pending.at ?? { x: window.innerWidth / 2 - 124, y: window.innerHeight / 3 };
  const left = Math.max(8, Math.min(at.x + 12, window.innerWidth - 260));
  const top = Math.max(8, Math.min(at.y + 12, window.innerHeight - 380));

  return (
    <div
      className="ann-pop"
      style={{ left, top }}
      role="dialog"
      aria-label="New issue"
      ref={(el) => {
        if (el) keepInside(el, at);
      }}
    >
      <AnnotateStyles />
      <div className="ann-faint">
        {stage === 'class' ? 'Class (hotkey)' : 'Severity (digit, u = uncertain)'}
      </div>
      <div className="classes" role="listbox" aria-label="Class">
        {classes.length === 0 && (
          <div className="ann-faint">This project has no class catalogue yet.</div>
        )}
        {classes.map((c) => (
          <button
            key={c.id}
            type="button"
            className="cls"
            aria-pressed={c.id === classId}
            onClick={() => {
              setClassId(c.id);
              setStage('severity');
            }}
          >
            <span className="ann-dot" style={sevStyle(c.color)} />
            {c.label}
            {c.hotkey && <kbd>{c.hotkey}</kbd>}
          </button>
        ))}
      </div>
      <div className="sevs" role="group" aria-label="Severity">
        {levels.map((v) => (
          <button
            key={String(v)}
            type="button"
            className={`ann-sev${v === 'uncertain' ? ' unc' : ''}`}
            style={sevStyle(severityColor(model, v))}
            aria-pressed={severity === v}
            title={
              v === 'uncertain'
                ? model?.uncertain?.label
                : `${model?.levels.find((l) => l.value === v)?.label ?? ''}: ${model?.levels.find((l) => l.value === v)?.criteria ?? ''}`
            }
            onClick={() => {
              setSeverity(v);
            }}
          >
            <i />
            {v === 'uncertain' ? '?' : v}
          </button>
        ))}
      </div>
      {error && <div className="ann-error">{error}</div>}
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button type="button" className="ann-btn ghost" onClick={cancelSighting}>
          Cancel
        </button>
        {selectedIssue && (
          <button
            type="button"
            className="ann-btn"
            title={`Add this shape to ${selectedIssue.code} (a)`}
            onClick={attach}
          >
            Add to {selectedIssue.code}
          </button>
        )}
        <button type="button" className="ann-btn primary" onClick={confirm}>
          Create issue
        </button>
      </div>
    </div>
  );
}

/**
 * Place the popover next to the click in window coordinates and inside the area that hosts it
 * (an ancestor marked `data-pop-bounds`, such as the stage, else the window), so side panels never
 * cover its buttons. A transformed or filtered ancestor makes `position: fixed` relative to
 * itself; its offset is measured and taken out.
 */
function keepInside(el: HTMLElement, at: { x: number; y: number }): void {
  const host = el.closest('[data-pop-bounds]');
  const r = host
    ? host.getBoundingClientRect()
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const w = el.offsetWidth || 248;
  const h = el.offsetHeight || 372;
  const right = Math.min(r.right, window.innerWidth);
  const bottom = Math.min(r.bottom, window.innerHeight);
  const x = Math.max(r.left + 8, Math.min(at.x + 12, right - w - 8));
  const y = Math.max(r.top + 8, Math.min(at.y + 12, bottom - h - 8));
  // the containing block's origin: where `left: 0; top: 0` lands in the window
  const now = el.getBoundingClientRect();
  const originX = now.left - (parseFloat(el.style.left) || 0);
  const originY = now.top - (parseFloat(el.style.top) || 0);
  el.style.left = `${String(x - originX)}px`;
  el.style.top = `${String(y - originY)}px`;
}
