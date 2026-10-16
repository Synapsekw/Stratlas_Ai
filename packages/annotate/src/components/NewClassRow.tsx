import type { IssueClass, SeverityModel } from '@aio/schema';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { NewClass } from '../model/catalogueOps';
import { useAnnotateReadOnly } from '../runtime';

/*
 * "+ New class..." (ANN-7): a row that turns into a name field; Enter creates the class and hands
 * it back, Escape cancels. The package does no IO: the app registers how a class is created
 * (`registerClassCreator`) and how a severity scale is added (`registerSeverityCreator`). Pickers
 * in this package read them with `useNewClass` and `useNewSeverity`.
 */

export type ClassCreator = (label: string, extra?: Omit<NewClass, 'label'>) => Promise<IssueClass>;

/** Adds one severity scale to the open project and hands that scale back. */
export type SeverityCreator = (model: SeverityModel) => Promise<SeverityModel>;

/** Option value a class `<select>` uses for its "+ New class..." entry. */
export const NEW_CLASS_OPTION = '__new-class__';

let creator: ClassCreator | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** The app's class creator (one at a time); the returned function takes it back. */
export function registerClassCreator(fn: ClassCreator): () => void {
  creator = fn;
  emit();
  return () => {
    if (creator !== fn) return;
    creator = null;
    emit();
  };
}

export function useClassCreator(): ClassCreator | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => creator,
  );
}

/** For pickers: the registered creator (null hides the row) and why it is off. */
export function useNewClass(): { create: ClassCreator | null; disabledReason: string | null } {
  const create = useClassCreator();
  const readOnly = useAnnotateReadOnly();
  return {
    create,
    disabledReason: readOnly ? 'This project is read-only, so classes cannot be added.' : null,
  };
}

let severityCreator: SeverityCreator | null = null;
const severityListeners = new Set<() => void>();
const emitSeverity = () => {
  for (const l of severityListeners) l();
};

/** The app's severity-scale creator (one at a time); the returned function takes it back. */
export function registerSeverityCreator(fn: SeverityCreator): () => void {
  severityCreator = fn;
  emitSeverity();
  return () => {
    if (severityCreator !== fn) return;
    severityCreator = null;
    emitSeverity();
  };
}

export function useSeverityCreator(): SeverityCreator | null {
  return useSyncExternalStore(
    (cb) => {
      severityListeners.add(cb);
      return () => {
        severityListeners.delete(cb);
      };
    },
    () => severityCreator,
  );
}

/** For the sighting picker: the registered scale creator and why it is off. */
export function useNewSeverity(): {
  create: SeverityCreator | null;
  disabledReason: string | null;
} {
  const create = useSeverityCreator();
  const readOnly = useAnnotateReadOnly();
  return {
    create,
    disabledReason: readOnly
      ? 'This project is read-only, so severity scales cannot be added.'
      : null,
  };
}

export interface NewClassRowProps {
  onCreate: ClassCreator;
  onCreated: (cls: IssueClass) => void;
  /** Why the row is off (a read-only project); shown as its title. */
  disabledReason?: string | null;
  /** Start as the name field (a picker's "+ New class..." option was chosen). */
  startOpen?: boolean;
  onCancel?: () => void;
  testId?: string;
}

export function NewClassRow({
  onCreate,
  onCreated,
  disabledReason = null,
  startOpen = false,
  onCancel,
  testId = 'new-class',
}: NewClassRowProps) {
  const [open, setOpen] = useState(startOpen);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="ann-btn ghost new-class"
        data-testid={testId}
        disabled={disabledReason !== null}
        title={disabledReason ?? 'Create a class with just a name'}
        onClick={() => {
          setOpen(true);
        }}
      >
        + New class...
      </button>
    );
  }

  const close = () => {
    setOpen(false);
    setLabel('');
    setError(null);
    onCancel?.();
  };
  const submit = async () => {
    if (busy || inFlight.current) return;
    const name = label.trim();
    if (!name) {
      setError('Type a name for the class.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const cls = await onCreate(name);
      setOpen(false);
      setLabel('');
      setError(null);
      onCreated(cls);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="new-class-row" data-testid={testId}>
      <input
        className="ann-input"
        autoFocus
        aria-label="New class name"
        placeholder="Class name"
        maxLength={80}
        value={label}
        readOnly={busy}
        onChange={(e) => {
          setLabel(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      {error && (
        <span className="ann-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
