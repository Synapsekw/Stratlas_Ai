import type { ChangeItem, ChangeSet, ChangeVerdict, Issue, Vec3 } from '@aio/schema';
import { issuePosition } from './issues';
import { registerRows, type RegisterFilter } from './register';
import type { SelectedItem } from './store';

/**
 * What "Show changes" draws on a view of one date: a pin per change item in its verdict colour,
 * where the item is on that date. An item that is not on the view's date (resolved on the later
 * view, new on the earlier one) is a ghost at the place it was or will be. The selected item is
 * outlined on both dates.
 */

export interface ChangeMarker {
  id: string;
  setId: string;
  kind: ChangeItem['kind'];
  verdict: ChangeVerdict;
  p: Vec3;
  label: string;
  color: string;
  selected: boolean;
  /** Not there on this date (the place it was, or will be). */
  ghost: boolean;
}

/** Verdict colours: appeared or worse red and amber, gone or better green, moved blue. */
export const VERDICT_COLOR: Record<ChangeVerdict, string> = {
  new: '#e5484d',
  added: '#e5484d',
  grown: '#f5a524',
  worsened: '#f5a524',
  fill: '#f5a524',
  changed: '#f5a524',
  resolved: '#30a46c',
  removed: '#30a46c',
  shrunk: '#30a46c',
  improved: '#30a46c',
  cut: '#3e8ef7',
  moved: '#3e8ef7',
  reshaped: '#3e8ef7',
  attributes: '#3e8ef7',
  'not-seen': '#8a94a6',
  unchanged: '#5b6472',
};

const ABSENT_LATER: ReadonlySet<ChangeVerdict> = new Set(['resolved', 'removed', 'not-seen']);
const ABSENT_EARLIER: ReadonlySet<ChangeVerdict> = new Set(['new', 'added']);

export interface MarkerInput {
  sets: readonly ChangeSet[];
  filter?: RegisterFilter;
  selected: SelectedItem | null;
  /** The date the view shows (absent: one view, every item at its place). */
  capture?: string | undefined;
  issues?: readonly Issue[];
}

export function changeMarkers(input: MarkerInput): ChangeMarker[] {
  const issues = new Map((input.issues ?? []).map((i) => [i.id, i]));
  const where = (id: string | undefined) => {
    const i = id ? issues.get(id) : undefined;
    return i ? (issuePosition(i)?.p ?? null) : null;
  };
  const out: ChangeMarker[] = [];
  for (const row of registerRows(input.sets, input.filter ?? {})) {
    const { item, setId } = row;
    const set = input.sets.find((s) => s.id === setId);
    const onFrom = input.capture !== undefined && input.capture === set?.from;
    const onTo = input.capture !== undefined && input.capture === set?.to;
    let p: Vec3 | null = item.at ?? null;
    if (item.kind === 'issue') {
      if (onFrom) p = where(item.from) ?? p;
      else if (onTo) p = where(item.to) ?? p;
    }
    if (!p) continue;
    const ghost =
      (onTo && ABSENT_LATER.has(item.verdict)) || (onFrom && ABSENT_EARLIER.has(item.verdict));
    out.push({
      id: item.id,
      setId,
      kind: item.kind,
      verdict: item.verdict,
      p,
      label: item.label ?? item.id,
      color: VERDICT_COLOR[item.verdict],
      selected: input.selected?.setId === setId && input.selected.itemId === item.id,
      ghost,
    });
  }
  return out;
}
