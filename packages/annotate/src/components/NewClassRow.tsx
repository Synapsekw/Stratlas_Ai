import type { IssueClass } from '@aio/schema';
import { useState, useSyncExternalStore } from 'react';
import { useAnnotateReadOnly } from '../runtime';

/*
 * "+ New class..." (ANN-7): a row that turns into a name field; Enter creates the class and hands
 * it back, Escape cancels. The package does no IO: the app registers how a class is created
 * (`registerClassCreator`), and pickers in this package read it with `useNewClass`.
 */

export type ClassCreator = (label: string) => Promise<IssueClass>;

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
    const name = label.trim();
    if (!name) {
      setError('Type a name for the class.');
      return;
    }
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
        disabled={busy}
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
        <span className="ann-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
