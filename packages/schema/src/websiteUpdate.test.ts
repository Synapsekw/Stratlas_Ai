import { describe, expect, it } from 'vitest';
import { Settings } from './ipc';
import { WebsiteUpdateStatus, WebsiteUpdateCheck } from './websiteUpdate';
describe('website update contracts', () => {
  it('preserves old settings and never accepts credentials in status', () => {
    expect(Settings.shape.websiteAutoUpdate.parse(undefined)).toBeUndefined();
    expect(
      WebsiteUpdateStatus.safeParse({
        accountEmail: null,
        phase: 'idle',
        currentAppVersion: '0.24.0',
        currentPipelineVersion: null,
        app: null,
        pipeline: null,
        error: null,
        restartAvailable: false,
        restartReason: null,
        recoveryAvailable: false,
        unsupportedReason: null,
        accessToken: 'secret',
      }).success,
    ).toBe(false);
  });
  it('rejects unsafe artifact names and non-stable versions', () => {
    expect(
      WebsiteUpdateCheck.safeParse({
        schema: 'quadrion.updates/1',
        targetAppVersion: '0.25.0-beta',
        app: null,
        pipeline: null,
      }).success,
    ).toBe(false);
  });
});
