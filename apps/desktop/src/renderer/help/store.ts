/** Open state of the help panel: F1, the palette, the title bar and every "?" link. */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/** A place in the guide: a chapter slug and, optionally, a heading anchor in it. */
export interface HelpTopic {
  chapter: string;
  anchor?: string;
}

export interface HelpState {
  open: boolean;
  topic: HelpTopic | null;
  /** Bumped on every open, so opening the same topic again scrolls to it again. */
  seq: number;
  openHelp: (topic?: HelpTopic) => void;
  closeHelp: () => void;
}

export const help = createStore<HelpState>()((set, get) => ({
  open: false,
  topic: null,
  seq: 0,
  openHelp: (topic) => {
    set({ open: true, topic: topic ?? get().topic, seq: get().seq + 1 });
  },
  closeHelp: () => {
    set({ open: false });
  },
}));

export function useHelp<T>(selector: (s: HelpState) => T): T {
  return useStore(help, selector);
}

/** Where each Settings page is explained. */
export const SETTINGS_HELP: Record<string, HelpTopic> = {
  ai: { chapter: 'ai-agent', anchor: 'add-a-provider-and-a-key' },
  usage: { chapter: 'ai-agent', anchor: 'what-is-sent-and-when' },
  privacy: { chapter: 'ai-agent', anchor: 'what-is-sent-and-when' },
  data: { chapter: 'settings', anchor: 'data-folder' },
  tools: { chapter: 'settings', anchor: 'processing-tools' },
  identity: { chapter: 'identity-and-team' },
  maps: { chapter: 'maps', anchor: 'offline-map-packs' },
  severity: { chapter: 'annotation-and-issues', anchor: 'severity-models' },
  branding: { chapter: 'reports-and-exports', anchor: 'report-branding' },
  graphics: { chapter: 'settings', anchor: 'graphics-quality' },
  appearance: { chapter: 'settings', anchor: 'appearance' },
  about: { chapter: 'settings', anchor: 'about-and-updates' },
};
