import { describe, expect, it } from 'vitest';
import { appHooks, registerAppHooks } from './tool-kit';

describe('registerAppHooks', () => {
  it('registers the screen hook, removes it on unregister and merges later hooks', () => {
    const off = registerAppHooks({ screen: () => 'media' });
    expect(appHooks.screen?.()).toBe('media');

    const openScreen = (): void => undefined;
    const offOpen = registerAppHooks({ openScreen });
    expect(appHooks.screen?.()).toBe('media');
    expect(appHooks.openScreen).toBe(openScreen);

    off();
    expect(appHooks.screen).toBeUndefined();
    expect(appHooks.openScreen).toBe(openScreen);

    offOpen();
    expect(appHooks.openScreen).toBeUndefined();
  });

  it('takes the filter, evidence and view hooks', () => {
    const off = registerAppHooks({
      showPhotos: () => ({ shown: 1, total: 2, severity: 3, severityLabel: 'High' }),
      showIssues: () => ({ shown: 4 }),
      showEvidence: () => true,
      captureView: () => () => undefined,
      viewFilters: () => ({
        photos: { onlyFindings: false, order: 'file', severity: null, scope: null },
        issues: {
          severity: 'uncertain',
          classId: null,
          status: null,
          text: '',
          sort: 'code',
          scope: null,
        },
      }),
    });
    expect(appHooks.showPhotos?.({ severity: 'highest' }).shown).toBe(1);
    expect(appHooks.showIssues?.({}).shown).toBe(4);
    expect(appHooks.showEvidence?.('i1')).toBe(true);
    expect(appHooks.viewFilters?.().issues.severity).toBe('uncertain');
    off();
    expect(appHooks.showPhotos).toBeUndefined();
  });
});
