import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { t } from './i18n';
import { SHORTCUTS, SHORTCUT_SCOPES, shortcutConflicts } from './shortcuts';

const KEYS = [
  'cleanup.tool',
  'cleanup.title',
  'cleanup.layer',
  'cleanup.none',
  'cleanup.copcOnly',
  'cleanup.readOnly',
  'cleanup.box.title',
  'cleanup.box.edit',
  'cleanup.box.editing',
  'cleanup.box.fit',
  'cleanup.box.keep',
  'cleanup.box.inside',
  'cleanup.box.outside',
  'cleanup.box.reset',
  'cleanup.box.size',
  'cleanup.height.title',
  'cleanup.height.min',
  'cleanup.height.max',
  'cleanup.height.clear',
  'cleanup.select.title',
  'cleanup.select.box',
  'cleanup.select.lasso',
  'cleanup.select.hint',
  'cleanup.select.count_one',
  'cleanup.select.count_other',
  'cleanup.select.hide',
  'cleanup.select.delete',
  'cleanup.select.setClass',
  'cleanup.select.cancel',
  'cleanup.select.near',
  'cleanup.select.full',
  'cleanup.noise.title',
  'cleanup.noise.run',
  'cleanup.noise.running',
  'cleanup.noise.settings',
  'cleanup.noise.neighbours',
  'cleanup.noise.multiplier',
  'cleanup.noise.low',
  'cleanup.noise.cell',
  'cleanup.noise.threshold',
  'cleanup.noise.result',
  'cleanup.noise.none',
  'cleanup.noise.undo',
  'cleanup.save.title',
  'cleanup.save.name',
  'cleanup.save.run',
  'cleanup.save.started',
  'cleanup.undo',
  'cleanup.redo',
  'cleanup.reset',
  'cleanup.notice.hidden',
  'cleanup.notice.deleted',
  'cleanup.notice.classSet',
  'cleanup.notice.noise',
  'cleanup.notice.reset',
  'cleanup.notice.undo',
  'cleanup.notice.dismiss',
  'cleanup.notice.error',
  'cleanup.menu.open',
  'cleanup.menu.noise',
  'cleanup.menu.save',
  'cleanup.menu.reset',
  'cleanup.export.apply',
  'cleanup.export.removes',
  'cleanup.export.nothing',
  'cleanup.part.boxOutside',
  'cleanup.part.boxInside',
  'cleanup.part.height',
  'cleanup.part.deletes_one',
  'cleanup.part.deletes_other',
  'cleanup.part.classes',
  'keys.scope.cleanup',
  'keys.cleanup.undo',
  'keys.cleanup.redo',
] as const;

describe('point cloud cleanup strings', () => {
  it('has every key, without dashes or emoji', () => {
    const cat = en as Record<string, string>;
    for (const k of KEYS) {
      expect(cat[k], k).toBeTruthy();
      expect(cat[k], k).not.toMatch(/[–—]|\p{Extended_Pictographic}/u);
    }
  });

  it('counts selected points and fills the noise result', () => {
    expect(t('cleanup.select.count', { count: 1 })).toBe('1 loaded point selected');
    expect(t('cleanup.select.count', { count: 1200 })).toBe('1200 loaded points selected');
    expect(t('cleanup.noise.result', { count: 60, share: '0.4 %' })).toBe(
      '60 points (0.4 %) marked as noise',
    );
  });
});

describe('cleanup shortcuts', () => {
  it('undo and redo in their own scope, shadowing the issue editor on purpose', () => {
    expect(SHORTCUT_SCOPES.some((s) => s.scope === 'cleanup')).toBe(true);
    const undo = SHORTCUTS.find((s) => s.id === 'cleanup.undo');
    const redo = SHORTCUTS.find((s) => s.id === 'cleanup.redo');
    expect(undo?.keys).toEqual(['Ctrl+Z']);
    expect(redo?.keys).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    expect(shortcutConflicts()).toEqual([]);
  });
});
