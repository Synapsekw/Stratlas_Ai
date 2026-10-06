/**
 * The journal service (M9 stream T1): every writer appends a signed op (fsync) before its atomic
 * state write; recovery and external-change detection on open; History, Verify, redaction and audit
 * exports (`journal:*`, `audit:export`, event `journal:changed`). T0 stubs: every channel answers
 * "not available yet" until T1 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface JournalIpcDeps {
  handle: Handle;
}

export function registerJournalIpc({ handle }: JournalIpcDeps): void {
  const what = 'The project history';
  handle('journal:history', () => notYet(what));
  handle('journal:verify', () => notYet(what));
  handle('journal:redact', () => notYet(what));
  handle('audit:export', () => notYet('The audit export'));
}
