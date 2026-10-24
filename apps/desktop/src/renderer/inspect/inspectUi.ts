/**
 * What Inspect shows that is not data: the open photo, whether the right panel is the photo's
 * findings or the review queue (and the class it is narrowed to), and the findings drawer of a
 * narrow window. It belongs to the open project and clears when another one opens.
 */
import type { PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface InspectUi {
  photo: PhotoPick | null;
  panel: 'photo' | 'queue';
  queueClass: string | null;
  drawerOpen: boolean;
}

const INITIAL: InspectUi = { photo: null, panel: 'photo', queueClass: null, drawerOpen: false };

export const inspectUi: StoreApi<InspectUi> = createStore<InspectUi>(() => INITIAL);

export function useInspectUi<T>(sel: (s: InspectUi) => T): T {
  return useStore(inspectUi, sel);
}

export function openPhoto(p: PhotoPick | null): void {
  inspectUi.setState({ photo: p });
}

export function openQueue(classId: string | null = null): void {
  inspectUi.setState({ panel: 'queue', queueClass: classId, drawerOpen: true });
}

export function leaveQueue(): void {
  inspectUi.setState({ panel: 'photo', queueClass: null });
}

export function resetInspect(): void {
  inspectUi.setState(INITIAL);
}

workspace.subscribe((ws, prev) => {
  if ((ws.project?.id ?? null) !== (prev.project?.id ?? null)) resetInspect();
});
