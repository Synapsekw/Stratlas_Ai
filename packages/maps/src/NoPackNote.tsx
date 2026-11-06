/**
 * The "No map pack installed" note itself, one dismissible line: at the foot of a map, or (`slot`)
 * in the host's own place for it, the stage's bottom-left hint slot (UI revision D5), where it
 * shows once per session and never in every pane.
 */
import { useSyncExternalStore } from 'react';
import { dismissNoPackNotice, noPackNoticeWanted, subscribeNoPackNotice } from './noPackNotice';

export function NoPackNote({ slot = false }: { slot?: boolean }) {
  return (
    // at the foot of a map it is laid out with the scale bar and the credits (map.css)
    <div role="note" data-testid="map-no-packs" className={`aio-map-note${slot ? ' in-slot' : ''}`}>
      No map pack installed: project layers only. Add a pack in Settings, Offline maps.
      <button
        type="button"
        className="aio-map-note-close"
        aria-label="Hide this note"
        onClick={dismissNoPackNotice}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </div>
  );
}

/** Some map on screen has no pack and the person has not hidden the note this session. */
export function useNoPackNoticeWanted(): boolean {
  return useSyncExternalStore(subscribeNoPackNotice, noPackNoticeWanted, noPackNoticeWanted);
}
