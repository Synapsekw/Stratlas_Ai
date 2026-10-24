import type { Sighting } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import {
  annotateUi,
  cancelSighting,
  confirmSighting,
  issueEditor,
  useAnnotateUi,
} from '../runtime';
import { ClassSeverityForm } from './ClassSeverityForm';
import { AnnotateStyles } from './styles';
import { useTaxonomy } from './common';

/**
 * Class and severity panel for a finished shape. The class list and the selected class's grades
 * stay on screen together. Keyboard: a class hotkey picks the class, then a digit picks the
 * severity (`u` for uncertain); Enter creates the issue, `a` adds the shape to the selected
 * issue, Esc cancels. New class opens a form for a name, colour, hotkey and severity scale,
 * including a scale generated as 1 to 3 or 1 to 5.
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
  const { classes } = useTaxonomy();
  const [attachError, setAttachError] = useState<string | null>(null);
  const open = pending !== null && kinds.includes(pending.sighting.on);
  const box = useRef<HTMLDivElement | null>(null);

  // Focus goes back where it was when the shape was finished (the tool button or the view) once
  // the panel closes with focus in it: Create issue, Cancel, Esc. Focus the person moved outside
  // the panel is left where it is.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let inside = false;
    const panel = box.current;
    const track = () => {
      inside = panel?.contains(document.activeElement) ?? false;
    };
    panel?.addEventListener('focusin', track);
    panel?.addEventListener('focusout', track);
    return () => {
      panel?.removeEventListener('focusin', track);
      panel?.removeEventListener('focusout', track);
      const now = document.activeElement;
      const lost = inside || now === null || now === document.body;
      if (lost && opener?.isConnected && opener !== now) opener.focus({ preventScroll: true });
    };
  }, [open]);

  // A fresh form for each new shape (derived during render, not in an effect).
  const [pendingSeen, setPendingSeen] = useState(pending);
  const [shapeSeq, setShapeSeq] = useState(0);
  if (pendingSeen !== pending) {
    setPendingSeen(pending);
    setShapeSeq((n) => n + 1);
    setAttachError(null);
  }

  const attach = () => {
    if (!pending || !selectedIssue) return;
    const r = issueEditor.addSighting(selectedIssue.id, pending.sighting);
    if (r.ok) annotateUi.setState({ pending: null });
    else setAttachError(r.error);
  };

  if (!open) return null;
  const at = pending.at ?? { x: window.innerWidth / 2 - 320, y: window.innerHeight / 5 };
  const left = Math.max(8, Math.min(at.x + 12, window.innerWidth - 656));
  const top = Math.max(8, Math.min(at.y + 12, window.innerHeight - 520));

  return (
    <div
      className="ann-pop"
      style={{ left, top }}
      role="dialog"
      aria-label="New issue"
      ref={(el) => {
        box.current = el;
        if (el) keepInside(el, at);
      }}
    >
      <AnnotateStyles />
      <div className="ann-pop-h">
        <b>New issue</b>
        <span className="ann-faint">
          Pick a class, then a severity. A letter picks the class, a digit picks the grade.
        </span>
      </div>
      <ClassSeverityForm
        key={shapeSeq}
        initialClassId={lastClassId ?? classes[0]?.id ?? null}
        initialSeverity={lastSeverity}
        confirmLabel="Create issue"
        onConfirm={confirmSighting}
        onCancel={cancelSighting}
        error={attachError}
        onKey={(k) => {
          if (k !== 'a' || !selectedIssue) return false;
          attach();
          return true;
        }}
        footer={
          selectedIssue && (
            <button
              type="button"
              className="ann-btn"
              title={`Add this shape to ${selectedIssue.code} (a)`}
              onClick={attach}
            >
              Add to {selectedIssue.code}
            </button>
          )
        }
      />
    </div>
  );
}

/**
 * Place the panel next to the click in window coordinates and inside the area that hosts it
 * (an ancestor marked `data-pop-bounds`, such as the stage, else the window), so side panels never
 * cover its buttons. A transformed or filtered ancestor makes `position: fixed` relative to
 * itself; its offset is measured and taken out. The panel narrows and stacks when the host is
 * tight.
 */
function keepInside(el: HTMLElement, at: { x: number; y: number }): void {
  const host = el.closest('[data-pop-bounds]');
  const r = host
    ? host.getBoundingClientRect()
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const right = Math.min(r.right, window.innerWidth);
  const bottom = Math.min(r.bottom, window.innerHeight);
  const availW = Math.max(280, right - r.left - 16);
  const availH = Math.max(280, bottom - r.top - 16);
  el.style.width = `${String(Math.min(640, availW))}px`;
  el.style.maxHeight = `${String(Math.min(680, availH))}px`;
  el.dataset.stack = availW < 520 ? 'true' : 'false';
  const w = el.offsetWidth || Math.min(640, availW);
  const h = el.offsetHeight || Math.min(560, availH);
  const x = Math.max(r.left + 8, Math.min(at.x + 12, right - w - 8));
  const y = Math.max(r.top + 8, Math.min(at.y + 12, bottom - h - 8));
  const now = el.getBoundingClientRect();
  const originX = now.left - (parseFloat(el.style.left) || 0);
  const originY = now.top - (parseFloat(el.style.top) || 0);
  el.style.left = `${String(x - originX)}px`;
  el.style.top = `${String(y - originY)}px`;
}
