import type { Issue } from '@aio/schema';

/**
 * One undoable command: the affected issues before and after, by id. `null` means the issue does
 * not exist on that side (created or deleted). Undo applies `before`, redo applies `after`.
 */
export interface Change {
  label: string;
  before: Readonly<Record<string, Issue | null>>;
  after: Readonly<Record<string, Issue | null>>;
  /** List positions of the issues before the change, so an undone delete returns in place. */
  at?: Readonly<Record<string, number>>;
}

export function invert(c: Change): Change {
  return { label: c.label, before: c.after, after: c.before, ...(c.at ? { at: c.at } : {}) };
}

/** Apply the `after` side of a change to a list of issues; existing issues keep their place. */
export function applyChange(issues: readonly Issue[], c: Change): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const i of issues) {
    if (!(i.id in c.after)) {
      out.push(i);
      continue;
    }
    seen.add(i.id);
    const next = c.after[i.id];
    if (next) out.push(next);
  }
  const placed: [number, Issue][] = [];
  for (const [id, next] of Object.entries(c.after)) {
    if (seen.has(id) || !next) continue;
    const at = c.at?.[id];
    if (at === undefined) out.push(next);
    else placed.push([at, next]);
  }
  for (const [at, next] of placed.sort((x, y) => x[0] - y[0]))
    out.splice(Math.min(at, out.length), 0, next);
  return out;
}

/** Linear undo/redo stack of changes. */
export class History {
  private done: Change[] = [];
  private undone: Change[] = [];

  constructor(private readonly limit = 200) {}

  push(c: Change): void {
    this.done.push(c);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  /** The change to apply to undo the last command, or null. */
  undo(): Change | null {
    const c = this.done.pop();
    if (!c) return null;
    this.undone.push(c);
    return invert(c);
  }

  /** The change to apply to redo, or null. */
  redo(): Change | null {
    const c = this.undone.pop();
    if (!c) return null;
    this.done.push(c);
    return c;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }
}
