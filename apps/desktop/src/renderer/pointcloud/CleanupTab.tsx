/** The Clean up tab's body (stage island D18): the panel, in the sidebar instead of on the stage. */
import { CleanupPanel } from './CleanupPanel';
import { useCleanupStage } from './cleanupStage';
import { useCleanup } from './cleanupStore';

export function CleanupTab() {
  const stage = useCleanupStage();
  const open = useCleanup((s) => s.panelOpen);
  return open ? <CleanupPanel stage={stage} inTab /> : null;
}
