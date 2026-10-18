import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { CorrectionComposerDraft } from './CorrectionPanel.types';
import type { CorrectionPin } from './correctionScene';

export function emptyCorrectionComposer(): CorrectionComposerDraft {
  return { targetMode: 'part', comment: '', evidenceIds: [], replies: {} };
}

interface DraftState {
  key: string | null;
  generation: number;
  composer: CorrectionComposerDraft;
  pin: CorrectionPin | undefined;
  pinRadiusM: number;
  requestId: string | undefined;
  view: 'before' | 'after';
  error: string | undefined;
  working: boolean;
}
const empty = (key: string | null, generation: number): DraftState => ({
  key,
  generation,
  composer: emptyCorrectionComposer(),
  pin: undefined,
  pinRadiusM: 2,
  requestId: undefined,
  view: 'before',
  error: undefined,
  working: false,
});
/** Ephemeral, one run only. No localStorage, project file or cross-project draft cache. */
const drafts = createStore<DraftState>(() => empty(null, 0));
const blank = empty(null, 0);

export function correctionDraftKey(projectId?: string, runId?: string): string | null {
  return projectId && runId ? JSON.stringify([projectId, runId]) : null;
}
export function setCorrectionDraftKey(key: string | null): void {
  const current = drafts.getState();
  if (current.key !== key) drafts.setState(empty(key, current.generation + 1), true);
}

/** Stable setters capture a generation, so a late save cannot clear a newer run's draft. */
export function useCorrectionDraft(key: string | null) {
  const current = useStore(drafts);
  useEffect(() => {
    setCorrectionDraftKey(key);
  }, [key]);
  const state = current.key === key ? current : blank;
  const generation = state.generation;
  const actions = useMemo(() => {
    const owns = () => {
      const now = drafts.getState();
      return key !== null && now.key === key && now.generation === generation;
    };
    const patch = (values: Partial<DraftState>) => {
      if (owns()) drafts.setState(values);
    };
    return {
      setPin: (pin: CorrectionPin | undefined) => {
        patch({ pin });
      },
      setPinRadiusM: (pinRadiusM: number) => {
        patch({ pinRadiusM });
      },
      setRequestId: (requestId: string | undefined) => {
        patch({ requestId });
      },
      setView: (view: 'before' | 'after') => {
        patch({ view });
      },
      setError: (error: string | undefined) => {
        patch({ error });
      },
      setWorking: (working: boolean) => {
        patch({ working });
      },
      setComposer: (values: Partial<CorrectionComposerDraft>) => {
        if (owns()) patch({ composer: { ...drafts.getState().composer, ...values } });
      },
      discard: () => {
        if (owns() && !drafts.getState().working)
          patch({ composer: emptyCorrectionComposer(), pin: undefined, pinRadiusM: 2 });
      },
      begin: () => {
        if (!owns() || drafts.getState().working) return false;
        patch({ working: true, error: undefined });
        return true;
      },
    };
  }, [key, generation]);
  return { ...state, ...actions };
}
