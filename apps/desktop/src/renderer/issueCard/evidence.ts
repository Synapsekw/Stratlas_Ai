/**
 * Evidence beside the 3D view: an issue picked in the 3D scene (its pin, its code label, or a row
 * of a count badge's list) also turns the stage to Split with the 3D view on one side and the
 * issue's photo on the other (the Photos pane, stepping through the issue's photos, its boxes
 * and masks drawn). Without a photo the Video pane opens at the sighting time; with nothing to
 * look at, only the card opens. The layout the person had is kept: closing the evidence (the x in
 * the pane, or Esc) puts the stage mode and the split sides back.
 *
 * On by default; the card has a switch to turn it off, remembered on this machine.
 */
import { bestAnchor } from '@aio/annotate';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { shell } from '../shell';
import type { StageMode } from '../store';
import { paneOptions, resolveSplit, type SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { evidenceKind, splitWithEvidence, type EvidenceKind } from './model';
import { lightbox } from './state';

export interface EvidenceOpen {
  projectId: string;
  issueId: string;
  kind: EvidenceKind;
  /** Index into the issue's photos. */
  index: number;
  /** The layout before the evidence opened (split absent: the default sides). */
  restore: { mode: StageMode; split: SplitPref | undefined };
}

const KEY = 'stratlas.evidenceSplit';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export const evidence = createStore<{ enabled: boolean; open: EvidenceOpen | null }>(() => ({
  enabled: readEnabled(),
  open: null,
}));

export function useEvidence<T>(
  selector: (s: { enabled: boolean; open: EvidenceOpen | null }) => T,
): T {
  return useStore(evidence, selector);
}

export function setEvidenceEnabled(on: boolean): void {
  evidence.setState({ enabled: on });
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // blocked storage: the choice holds for this run only
  }
}

/** Open (or move) the evidence of an issue beside the 3D view. Returns false when it has none. */
export function openEvidence(issueId: string): boolean {
  const ws = workspace.getState();
  const project = ws.project;
  const issue = ws.issues.find((i) => i.id === issueId);
  if (!project || !issue) return false;
  const kind = evidenceKind(project.manifest, issue);
  const open = evidence.getState().open;
  if (!kind) {
    if (open) closeEvidence();
    return false;
  }
  const sh = shell.getState();
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const restore =
    open?.projectId === project.id ? open.restore : { mode: sh.stageMode, split: saved };
  const sides = resolveSplit(saved, paneOptions(project.manifest.layers, 1));
  // two survey dates side by side (compare): the evidence replaces the comparison
  const compared = saved !== undefined && saved.left === saved.right;
  stagePrefs.getState().update(project.id, { split: splitWithEvidence(sides, kind, compared) });
  evidence.setState({ open: { projectId: project.id, issueId, kind, index: 0, restore } });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
  if (kind === 'video') {
    const s = issue.sightings.find((x) => x.on === 'video');
    const layer = project.manifest.layers.find((l) => l.id === s?.layer);
    if (s?.on === 'video' && layer?.kind === 'video') {
      ws.setActiveClip(layer.id);
      ws.setTime(layer.flight.startUtcMs + layer.offsetMs + (s.track[0]?.t ?? 0) * 1000);
    }
  }
  // the 3D side looks at the issue
  const p = bestAnchor(issue);
  if (p) ws.flyTo({ kind: 'point', p, distance: 4 });
  return true;
}

/** Put the stage back as it was before the evidence opened. */
export function closeEvidence(restoreMode = true): void {
  const open = evidence.getState().open;
  if (!open) return;
  evidence.setState({ open: null });
  stagePrefs.getState().update(open.projectId, { split: open.restore.split });
  if (restoreMode && shell.getState().stageMode !== open.restore.mode)
    shell.getState().setStageMode(open.restore.mode);
}

/** The person chose the split sides themselves: their choice stands, nothing is put back. */
export function dropEvidence(): void {
  if (evidence.getState().open) evidence.setState({ open: null });
}

export function stepEvidence(dir: 1 | -1, count: number): void {
  const open = evidence.getState().open;
  if (!open || count < 2) return;
  evidence.setState({ open: { ...open, index: (open.index + dir + count) % count } });
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * Esc closes the evidence; leaving the split or the project drops it (the sides go back).
 * Returns an unsubscribe function.
 */
export function startEvidenceSplit(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return;
    if (!evidence.getState().open || lightbox.getState().state) return;
    if (shell.getState().screen !== 'scene') return;
    e.preventDefault();
    closeEvidence();
  };
  window.addEventListener('keydown', onKey);
  const stopShell = shell.subscribe((s, prev) => {
    if (s.stageMode !== prev.stageMode && s.stageMode !== 'split') closeEvidence(false);
  });
  const stopWs = workspace.subscribe((s, prev) => {
    if (s.project !== prev.project && evidence.getState().open?.projectId !== s.project?.id)
      closeEvidence(false);
  });
  return () => {
    window.removeEventListener('keydown', onKey);
    stopShell();
    stopWs();
  };
}
