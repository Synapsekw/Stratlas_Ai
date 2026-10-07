import { issueSaver } from '@aio/annotate';
import type { AioBridge, IpcEvent } from '@aio/schema';
import { createBridge, type Bridge } from '../bridge';

/**
 * What the History panel and the Audit trail screen need from the app: the typed bridge, the
 * `journal:changed` event and a signal after the issue list was written (the journal appends its
 * ops in that write). Injected in tests.
 */
export interface AuditApi {
  call: Bridge['call'];
  /** Records of an open project changed under the renderer (merge, import, external edit). */
  onJournalChanged(listener: (e: IpcEvent<'journal:changed'>) => void): () => void;
  /** The issue list reached disk (a local edit is in the journal now). */
  onIssuesSaved(listener: () => void): () => void;
}

let api: AuditApi | null = null;

/** The app's AuditApi, made on first use (window.aio is absent in plain tests). */
export function auditApi(): AuditApi {
  if (api) return api;
  const aio = (globalThis as { aio?: AioBridge }).aio;
  const bridge = createBridge(aio);
  api = {
    call: bridge.call.bind(bridge),
    onJournalChanged: (listener) => aio?.on('journal:changed', listener) ?? (() => undefined),
    onIssuesSaved: (listener) => {
      let last = issueSaver.status.savedAt;
      return issueSaver.subscribe((s) => {
        if (s.state !== 'saved' || s.savedAt === last) return;
        last = s.savedAt;
        listener();
      });
    },
  };
  return api;
}
