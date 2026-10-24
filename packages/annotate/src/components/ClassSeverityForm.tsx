import type { Issue } from '@aio/schema';
import { useEffect, useState, type ReactNode } from 'react';
import { ClassComposer, SeverityList } from './ClassComposer';
import { useNewClass, useNewSeverity } from './NewClassRow';
import { useTaxonomy } from './common';

export interface ClassSeverityFormProps {
  initialClassId: string | null;
  initialSeverity: Issue['severity'] | null;
  confirmLabel: string;
  /** Null when done, else the error to show. */
  onConfirm: (classId: string, severity: Issue['severity']) => string | null;
  onCancel: () => void;
  /**
   * Extra controls in the button row, between Cancel and the confirm button (the sighting
   * picker's Add to the selected issue; Inspect's Same as an existing finding).
   */
  footer?: ReactNode;
  /** Rows under the lists, above the button row (Inspect's Same as and Add as a class). */
  rows?: ReactNode;
  /**
   * A key the form is about to read as a class hotkey or a grade: return true to take it instead
   * (the sighting picker's `a`, add to the selected issue). Keys typed in a field never get here.
   */
  onKey?: (key: string) => boolean;
  /** An error from the host's own controls (a footer action), shown when the form has none. */
  error?: string | null;
}

/**
 * The class list with a search, the picked class's severity grades, an error line, and Cancel
 * and confirm. New class opens a form for a class you name yourself, with a colour, hotkey and
 * severity scale. Picking a class whose scale lacks the chosen grade clears the grade.
 *
 * Keyboard while mounted: a class hotkey picks the class, a digit the grade (`u` for uncertain),
 * Enter confirms, Esc cancels. Mount it fresh (a new `key`) to start over on new initial values.
 */
export function ClassSeverityForm({
  initialClassId,
  initialSeverity,
  confirmLabel,
  onConfirm,
  onCancel,
  footer,
  rows,
  onKey,
  error: hostError = null,
}: ClassSeverityFormProps) {
  const { classes, models } = useTaxonomy();
  const { create, disabledReason } = useNewClass();
  const { create: createModel } = useNewSeverity();
  const [classId, setClassId] = useState<string | null>(initialClassId);
  const [severity, setSeverity] = useState<Issue['severity'] | null>(initialSeverity);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cls = classes.find((c) => c.id === classId);
  const model = models.find((m) => m.id === cls?.severityModel) ?? null;
  const levels: Issue['severity'][] = [
    ...(model?.levels.map((l) => l.value) ?? []),
    ...(model?.uncertain ? (['uncertain'] as const) : []),
  ];
  const q = query.trim().toLowerCase();
  const shown = q ? classes.filter((c) => c.label.toLowerCase().includes(q)) : classes;

  const pickClass = (id: string) => {
    setClassId(id);
    const next = classes.find((c) => c.id === id);
    const nextModel = models.find((m) => m.id === next?.severityModel);
    const values = new Set<Issue['severity']>([
      ...(nextModel?.levels.map((l) => l.value) ?? []),
      ...(nextModel?.uncertain ? (['uncertain'] as const) : []),
    ]);
    if (severity !== null && !values.has(severity)) setSeverity(null);
    setError(null);
  };

  const confirm = () => {
    if (!classId || severity === null) {
      setError('Pick a class and a severity');
      return;
    }
    setError(onConfirm(classId, severity));
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (typing) return;
      const k = e.key.toLowerCase();
      if (composing) {
        if (k === 'escape') setComposing(false);
        else return;
      } else if (k === 'escape') {
        onCancel();
      } else if (k === 'enter') {
        confirm();
      } else if (onKey?.(k)) {
        // taken by the host
      } else {
        const hit = classes.find((c) => c.hotkey?.toLowerCase() === k);
        if (hit) pickClass(hit.id);
        else if (k === 'u' && model?.uncertain) setSeverity('uncertain');
        else if (/^\d$/.test(k) && levels.includes(Number(k))) setSeverity(Number(k));
        else return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });

  if (composing && create) {
    return (
      <ClassComposer
        classes={classes}
        models={models}
        onCreateClass={create}
        onCreateModel={createModel}
        onCancel={() => {
          setComposing(false);
          setError(null);
        }}
        onCreated={(created) => {
          setClassId(created.id);
          setSeverity(null);
          setQuery('');
          setComposing(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <>
      <div className="ann-pop-body">
        <div className="ann-pop-col">
          <input
            className="ann-input ann-pop-search"
            aria-label="Find a class"
            placeholder="Find a class"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          <div className="classes" role="listbox" aria-label="Class">
            {classes.length === 0 && (
              <div className="ann-faint ann-pop-pad">
                {create && !disabledReason
                  ? 'No classes yet. Create one below.'
                  : 'This project has no class catalogue yet.'}
              </div>
            )}
            {classes.length > 0 && shown.length === 0 && (
              <div className="ann-faint ann-pop-pad">No class matches.</div>
            )}
            {shown.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cls"
                aria-pressed={c.id === classId}
                onClick={() => {
                  pickClass(c.id);
                }}
              >
                <span className="ann-dot" style={{ ['--sev' as string]: c.color }} />
                <span className="cls-text">
                  <span className="cls-name">{c.label}</span>
                  {models.length > 1 && (
                    <span className="cls-meta">
                      {models.find((m) => m.id === c.severityModel)?.name ?? ''}
                    </span>
                  )}
                </span>
                {c.hotkey && <kbd>{c.hotkey}</kbd>}
              </button>
            ))}
          </div>
          {create && (
            <button
              type="button"
              className="ann-btn ghost new-class"
              data-testid="picker-new-class"
              disabled={disabledReason !== null}
              title={disabledReason ?? 'Create a class, and a severity scale if you need one'}
              onClick={() => {
                setComposing(true);
                setError(null);
              }}
            >
              New class
            </button>
          )}
        </div>
        <div className="ann-pop-col">
          <div className="ann-pop-col-h">
            <b>{cls?.label ?? 'Severity'}</b>
            {model && <span className="ann-faint">{model.name}</span>}
          </div>
          {cls ? (
            <SeverityList
              model={model}
              severity={severity}
              onPick={(v) => {
                setSeverity(v);
                setError(null);
              }}
            />
          ) : (
            <div className="ann-faint ann-pop-pad">Pick a class to see its grades.</div>
          )}
        </div>
      </div>
      {(error ?? hostError) && <div className="ann-error ann-pop-error">{error ?? hostError}</div>}
      {rows != null && <div className="ann-pop-rows">{rows}</div>}
      <div className="ann-pop-foot">
        <button type="button" className="ann-btn ghost" onClick={onCancel}>
          Cancel
        </button>
        {footer}
        <button type="button" className="ann-btn primary" onClick={confirm}>
          {confirmLabel}
        </button>
      </div>
    </>
  );
}
