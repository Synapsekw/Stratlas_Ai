import { useAnnotateReadOnly } from '@aio/annotate';
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { photoUi } from '../photogrammetry/store';
import { useShell } from '../shell';
import './sidebarProcessing.css';

/**
 * Whether **Create maps from photos** is offered: a project is open, not a package, and the person
 * may change it (a reviewer who may only look gets none).
 */
export function useCanCreateMaps(): boolean {
  const project = useWorkspace((s) => s.project !== null);
  const pkg = useShell((s) => s.pkg !== null);
  const lookOnly = useAnnotateReadOnly();
  return project && !pkg && !lookOnly;
}

/**
 * The Layers column's Processing section: a heading and **Create maps from photos** as a calm row,
 * in plain sight without opening anything (founder, 31 Oct 2026). It opens the same wizard as the
 * Processing drawer's primary, a photo project's library card, the offer over the scene and the
 * rail's Processing group (Rail.tsx), which keeps it in sight on every screen and with the column
 * folded. Not shown without a project, in a package, or to a reviewer who may only look. The
 * layout spike shows the same section at the top of its Layers column.
 */
export function SidebarProcessing() {
  useT();
  const can = useCanCreateMaps();
  if (!can) return null;
  const heading = t('processing.title');
  const label = t('processing.createMaps');
  return (
    <section className="sb-sec sb-proc" aria-label={heading} data-testid="sidebar-processing">
      <div className="sb-proc-h caps" aria-hidden="true">
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
