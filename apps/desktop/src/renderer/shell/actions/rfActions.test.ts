// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, t } from '@aio/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openRfTab } = vi.hoisted(() => ({ openRfTab: vi.fn() }));
vi.mock('../../rf/rfTab', () => ({ openRfTab }));

const { registerRfActions } = await import('./rfActions');
const { rfStore } = await import('../../rf/rfStore');

const manifest = { captures: [], layers: [] } as unknown as ProjectManifest;
const menu = () =>
  actionsFor({ kind: 'project' }, makeActionCtx({ manifest })).find((i) => i.id === 'rf.coverage');

let off: () => void;
beforeEach(() => {
  off = registerRfActions();
  openRfTab.mockClear();
});
afterEach(() => {
  off();
  rfStore.setState({ antennas: null, running: false });
});

describe('rf coverage action', () => {
  it('is hidden when the project has no antennas file', () => {
    rfStore.setState({ antennas: null });
    expect(menu()).toBeUndefined();
  });

  it('is offered as Coverage... once the project has antennas', () => {
    rfStore.setState({ antennas: { antennas: [] } as never });
    const item = menu();
    expect(item?.label).toBe('Coverage…');
    expect(item?.disabled).toBe(false);
  });

  it('is greyed with a reason during a coverage run', () => {
    rfStore.setState({ antennas: { antennas: [] } as never, running: true });
    expect(menu()?.disabled).toBe(t('actions.rf.running'));
  });

  it('opens the RF tab when run', () => {
    rfStore.setState({ antennas: { antennas: [] } as never });
    menu()?.run();
    expect(openRfTab).toHaveBeenCalledOnce();
  });
});
