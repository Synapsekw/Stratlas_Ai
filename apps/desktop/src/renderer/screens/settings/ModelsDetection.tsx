/**
 * Settings, Models and detection: the models that find objects in photos and frames (from the AI
 * providers page), the Analytics pack that runs them and the detector library (from Processing
 * tools). The page is a list of sections, so later ones (bench results, learning status,
 * suggested thresholds, add-on packs: design section 13) are appended after the library without
 * moving anything. Each section carries its focus id, which deep links bring into view.
 */
import type { ReactElement } from 'react';
import type { SettingsFocus } from '../../store';
import { Addons } from './Addons';
import { AnalyticsPack } from './AnalyticsPack';
import { DetectionModels } from './DetectionModels';
import { DetectorLibrary } from './DetectorLibrary';

export const MODELS_SECTIONS: readonly {
  /** `addons` has no deep link yet, so it is not a SettingsFocus of the shell store. */
  focus: SettingsFocus | 'addons';
  Section: () => ReactElement | null;
}[] = [
  { focus: 'detection-models', Section: DetectionModels },
  { focus: 'analytics-pack', Section: AnalyticsPack },
  { focus: 'detector-library', Section: DetectorLibrary },
  { focus: 'addons', Section: Addons },
];

export function ModelsDetection(): ReactElement {
  return (
    <>
      {MODELS_SECTIONS.map(({ focus, Section }) => (
        <div key={focus} data-settings-focus={focus}>
          <Section />
        </div>
      ))}
    </>
  );
}
