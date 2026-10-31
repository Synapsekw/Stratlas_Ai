import { useAnnotateReadOnly } from '@aio/annotate';
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { photoUi } from '../photogrammetry/store';
import { useShell } from '../shell';
import './sidebarProcessing.css';

/**
 * The sidebar's Processing section: a heading and **Create maps from photos** as a calm row, in
 * plain sight without opening anything (founder, 31 Oct 2026). It opens the same wizard as the
 * Processing drawer's primary, a photo project's library card and the offer over the scene. Not
 * shown without a project, in a package, or to a reviewer who may only look. Folded to the rail,
 * the row keeps its glyph and names itself in a tip, as the nav rows do. The layout spike shows
 * the same section at the top of its Layers column.
 */
export function SidebarProcessing() {
  useT();
  const project = useWorkspace((s) => s.project !== null);
  const pkg = useShell((s) => s.pkg !== null);
  const lookOnly = useAnnotateReadOnly();
  if (!project || pkg || lookOnly) return null;
  const heading = t('processing.title');
  const label = t('processing.createMaps');
  return (
    <section className="sb-sec sb-proc" aria-label={heading} data-testid="sidebar-processing">
      <div className="sb-proc-h caps sb-hide" aria-hidden="true">
        {heading}
      </div>
      <button
        type="button"
        className="nav-item"
        data-testid="sidebar-create-maps"
        onClick={() => {
          photoUi.getState().openWizard();
        }}
      >
        <Icon name="photo" />
        <span className="lbl">{label}</span>
        <span className="tip" aria-hidden="true">
          {label}
        </span>
      </button>
    </section>
  );
}
