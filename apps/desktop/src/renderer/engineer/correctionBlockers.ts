import type { SessionState } from '@aio/ai';

type Availability = SessionState['availability'];
interface Kinds {
  photos: boolean;
  scans: boolean;
  drawings: boolean;
}

export type CorrectionBlocker =
  | { kind: 'checking' }
  | { kind: 'route'; message: string } // availability disabled; fix = open Settings > AI
  | { kind: 'conversation' } // agent busy or preview open
  | { kind: 'permission'; missing: ('photos' | 'scans' | 'drawings')[] } // fix = project settings
  | { kind: 'readOnly' };

/** What stops a correction from being sent right now, or null. Permissions mirror `permitted` in correctionTools. */
export function correctionSendBlocker(input: {
  readOnly: boolean;
  availability: Availability;
  agentBusy: boolean;
  preview: boolean;
  required: Kinds;
  allowed: Kinds;
}): CorrectionBlocker | null {
  const { availability: a } = input;
  if (input.readOnly) return { kind: 'readOnly' };
  if (a.status === 'checking') return { kind: 'checking' };
  if (a.status === 'disabled') return { kind: 'route', message: a.message };
  if (input.agentBusy || input.preview) return { kind: 'conversation' };
  if (a.cloud) {
    const missing = (['photos', 'scans', 'drawings'] as const).filter(
      (k) => input.required[k] && !input.allowed[k],
    );
    if (missing.length) return { kind: 'permission', missing };
  }
  return null;
}
