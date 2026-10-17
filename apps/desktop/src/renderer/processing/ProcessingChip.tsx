/**
 * The jobs chip of the sidebar's status row (shell/SidebarStatus.tsx): how many jobs the open
 * project runs ("1 job"), and the button that opens the processing drawer. With no project of its
 * own (none open, or a read-only package) it shows only while another project runs something.
 */
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useJobs, useShell } from '../shell';
import { chipState, needsAttention, projectJobs, runningElsewhere, type ChipState } from './model';
import { processing, seenAtOf, useProcessing } from './store';
import './processing.css';

export function chipText(state: ChipState): string {
  switch (state.kind) {
    case 'one':
      return t('processing.chip.one', { pct: state.pct });
    case 'many':
      return t('processing.chip.many', { count: state.count });
    case 'attention':
      return t('processing.chip.attention', { count: state.count });
    case 'elsewhere':
      return t('processing.chip.elsewhere', { count: state.count });
    case 'idle':
    case 'hidden':
      return t('processing.title');
  }
}

/**
 * What the chip shows in the sidebar's status row ("● Online · 1 job"): how many jobs run, or
 * what needs attention. The full state is its accessible name (chipLabel).
 */
export function chipWords(state: ChipState): string {
  switch (state.kind) {
    case 'one':
      return t('status.jobs', { count: 1 });
    case 'many':
    case 'elsewhere':
      return t('status.jobs', { count: state.count });
    case 'attention':
      return t('processing.chip.attention', { count: state.count });
    case 'idle':
    case 'hidden':
      return t('status.jobs', { count: 0 });
  }
}

/** The button's name for a screen reader: the feature first, whatever the visible words. */
export function chipLabel(state: ChipState): string {
  const text = chipText(state);
  return text.startsWith(t('processing.title'))
    ? text
    : t('processing.chip.label', { state: text });
}

export function ChipView({
  state,
  open,
  onToggle,
}: {
  state: ChipState;
  open: boolean;
  onToggle: () => void;
}) {
  if (state.kind === 'hidden') return null;
  return (
    <button
      type="button"
      className="chip-status proc-chip"
      data-testid="processing-chip"
      data-state={state.kind}
      title={t('processing.chip.tip')}
      aria-label={chipLabel(state)}
      aria-expanded={open}
      aria-controls="processing-drawer"
      onClick={onToggle}
    >
      <Icon name={state.kind === 'attention' ? 'warn' : 'clock'} size={14} />
      <span className="proc-words">{chipWords(state)}</span>
    </button>
  );
}

export function ProcessingChip() {
  useT();
  const all = useJobs((s) => s.jobs);
  const project = useWorkspace((s) => s.project?.root ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  const open = useProcessing((s) => s.open);
  const start = useProcessing((s) => s.start);
  const root = pkg ? null : project;
  const seenAt = useProcessing((s) => seenAtOf(s, root));
  const state = useMemo(() => {
    const mine = projectJobs(all, root);
    return chipState({
      own: root !== null,
      mine,
      elsewhere: runningElsewhere(all, root).length,
      // while the drawer is open the person is looking
      attention: open ? 0 : needsAttention(mine.finished, { start, seenAt }).length,
    });
  }, [all, root, open, start, seenAt]);
  return (
    <ChipView
      state={state}
      open={open}
      onToggle={() => {
        const p = processing.getState();
        if (p.open) p.closeDrawer();
        else p.openDrawer();
      }}
    />
  );
}
