import { AgentToggle } from '../agent/AgentToggle';
import { SyncStatus } from '../team/SyncStatus';

/** The Agent and Share controls, at the end of the right sidebar's header or a page header. */
export function HeaderControls() {
  return (
    <>
      <AgentToggle />
      <SyncStatus />
    </>
  );
}

/**
 * The right sidebar's 40 px header row: the Agent and Share controls. It is a window drag region
 * (styles.css), and its end keeps clear of the window's caption buttons (`--caption-end`). With
 * the sidebar folded away it goes with it, and only the window's own buttons stay.
 */
export function RightHeader() {
  return (
    <div className="right-head" data-testid="right-head">
      <HeaderControls />
    </div>
  );
}
