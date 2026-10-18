import { useAnnotateReadOnly } from '@aio/annotate';
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { photoUi } from '../photogrammetry/store';
import { useShell } from '../shell';

/**
 * Create maps from photos, under the project switcher: the app's main job in plain sight. It opens
 * the same wizard as the Processing drawer's button and a photos layer's menu. Not shown without a
 * project, in a package, or to a reviewer who may only look. Folded to the rail it keeps its glyph
 * and names itself in a tip, as the project switcher does.
 */
export function CreateMapsButton() {
  useT();
  const project = useWorkspace((s) => s.project !== null);
  const pkg = useShell((s) => s.pkg !== null);
  const lookOnly = useAnnotateReadOnly();
  if (!project || pkg || lookOnly) return null;
  const label = t('processing.createMaps');
  return (
    <button
      type="button"
      className="btn primary sb-create-maps"
      data-testid="sidebar-create-maps"
      aria-label={label}
      onClick={() => {
        photoUi.getState().openWizard();
      }}
    >
      <Icon name="photo" size={16} />
      <span className="lbl">{label}</span>
      <span className="tip" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}
