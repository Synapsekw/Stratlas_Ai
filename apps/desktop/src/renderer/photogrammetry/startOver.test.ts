import type { PhotoRun } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { START_OVER, replaceAfterStart, wizardInitialOf } from './startOver';

type Run = Pick<PhotoRun, 'id' | 'photos' | 'preset' | 'crs' | 'settings' | 'capture'>;
const run = (p: Partial<Run> = {}): Run => ({
  id: '20261012-0930',
  photos: { source: { layer: 'photos-a' }, count: 120 },
  preset: 'high',
  crs: { epsg: 32640 },
  settings: {
    run: '20261012-0930',
    preset: 'high',
    gnss: 'rtk',
    crs: { epsg: 32640 },
    products: ['ortho', 'dsm'],
  },
  capture: 'c1',
  ...p,
});
const layers = [{ id: 'photos-a', kind: 'photos' as const }];

describe('wizardInitialOf', () => {
  it('takes the photos, preset, GNSS, coordinate system, products and date of the run', () => {
    expect(wizardInitialOf(run(), layers)).toEqual({
      source: { layer: 'photos-a' },
      preset: 'high',
      gnss: 'rtk',
      crs: { epsg: 32640 },
      products: ['ortho', 'dsm'],
      capture: 'c1',
      replaces: '20261012-0930',
    });
  });

  it('also reads products from a { products } object, and drops unknown names', () => {
    const x = wizardInitialOf(
      run({ settings: { gnss: 'rtk', products: { products: ['mesh', 'bogus', 'cloud'] } } }),
      layers,
    );
    expect(x.products).toEqual(['mesh', 'cloud']);
  });

  it('a run that failed before its maps: the preset defaults and automatic GNSS', () => {
    const x = wizardInitialOf(run({ settings: { run: 'r' } }), layers);
    expect(x.gnss).toBe('auto');
    expect(x.products.length).toBeGreaterThan(0);
    expect(wizardInitialOf(run({ settings: undefined }), layers).gnss).toBe('auto');
  });

  it('leaves the photos step empty and says why when the photos layer was removed', () => {
    const x = wizardInitialOf(run(), []);
    expect(x.source).toBeNull();
    expect(x.missing).toMatch(/photos of run 20261012-0930 were removed/);
  });

  it('leaves the photos step empty when every folder is gone, and keeps the ones still there', () => {
    const src = { folders: ['C:/A', 'C:/B'] };
    const gone = wizardInitialOf(run({ photos: { source: src, count: 2 } }), layers, [
      'C:/A',
      'C:/B',
    ]);
    expect(gone.source).toBeNull();
    expect(gone.missing).toMatch(/not there any more/);
    const half = wizardInitialOf(run({ photos: { source: src, count: 2 } }), layers, ['C:/A']);
    expect(half.source).toEqual({ folders: ['C:/B'] });
    expect(half.missing).toMatch(/C:\/A/);
  });

  it('is offered on failed and cancelled runs only', () => {
    expect([...START_OVER].sort()).toEqual(['cancelled', 'failed']);
  });
});

describe('replaceAfterStart', () => {
  it('removes nothing when the start was refused or there is nothing to replace', async () => {
    const remove = vi.fn(() => Promise.resolve(null));
    expect(await replaceAfterStart(false, wizardInitialOf(run(), layers), remove)).toBeNull();
    expect(await replaceAfterStart(true, undefined, remove)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the replaced run once the new one started', async () => {
    const remove = vi.fn(() => Promise.resolve(null));
    expect(await replaceAfterStart(true, wizardInitialOf(run(), layers), remove)).toBeNull();
    expect(remove).toHaveBeenCalledWith('20261012-0930');
  });

  it('a failed removal does not stop the new run: it is a note', async () => {
    const remove = () =>
      Promise.resolve('Creating maps for run 20261012-0930 is still running. Cancel it first.');
    expect(await replaceAfterStart(true, wizardInitialOf(run(), layers), remove)).toBe(
      'Run 20261012-0930 is still there: Creating maps for run 20261012-0930 is still running. Cancel it first.',
    );
  });

  it('a removal that throws is the same note, never an error', async () => {
    const remove = () => Promise.reject(new Error('IPC channel closed'));
    expect(await replaceAfterStart(true, wizardInitialOf(run(), layers), remove)).toBe(
      'Run 20261012-0930 is still there: IPC channel closed',
    );
  });
});
