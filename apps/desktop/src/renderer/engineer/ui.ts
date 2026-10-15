import { createStore } from 'zustand/vanilla';
import { shell } from '../shell';
import { engineeringUiOn } from './flags';

export { ENGINEERING_SOURCES, engineeringUiOn } from './flags';

/** Whether the setup or the run panel is open, and which layers the setup starts with. */
export const engineerUi = createStore<{
  open: boolean;
  /** Layers chosen as sources when the setup opens (the layer it was opened from). */
  preselect: string[];
  show(preselect?: readonly string[]): void;
  hide(): void;
}>((set) => ({
  open: false,
  preselect: [],
  show: (preselect = []) => {
    set({ open: true, preselect: [...preselect] });
  },
  hide: () => {
    set({ open: false });
  },
}));

/**
 * Create engineering model from anywhere (the palette, a layer's right-click menu, the Model
 * builder, an import result): opens the setup with those layers chosen, or the run panel during a
 * run. It only opens: nothing is measured or sent until the person starts.
 */
export function createEngineeringModel(preselect: readonly string[] = []): void {
  if (!engineeringUiOn()) return;
  const s = shell.getState();
  s.setPalette(false);
  if (s.screen !== 'scene') s.go('scene');
  engineerUi.getState().show(preselect);
}
