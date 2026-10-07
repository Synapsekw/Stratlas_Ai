import { envVar } from '@aio/brand/env';
import type { LaunchGateMode } from '@aio/schema';

/**
 * May this run show the launch screen? Automated runs skip it so a test lands straight in the app:
 * every app an e2e test starts has QUADRION_E2E=1. QUADRION_SHOW_GATE=1 brings it back for the
 * launch screen's own spec (the Settings switch still applies); QUADRION_SHOW_GATE=0 skips it in
 * any run (scripts, screenshots). The legacy STRATLAS_* names count too.
 */
export function launchGateMode(env: Record<string, string | undefined>): LaunchGateMode {
  const show = envVar(env, 'SHOW_GATE');
  if (show === '1') return 'auto';
  if (show === '0') return 'skip';
  return envVar(env, 'E2E') === '1' ? 'skip' : 'auto';
}
