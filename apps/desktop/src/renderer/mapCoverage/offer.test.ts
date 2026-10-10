import type { PackRegion } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  handledProjects,
  markHandled,
  offerFor,
  prefsOf,
  queueRegions,
  type OfferInput,
} from './offer';
import { chosenRegions, coveragePlan } from './plan';

const base: OfferInput = {
  located: true,
  covered: false,
  demo: false,
  handled: false,
  offlineOnly: false,
  prefs: DEFAULT_PREFS,
  regions: 3,
};

describe('offerFor', () => {
  it('asks first by default', () => {
    expect(DEFAULT_PREFS).toEqual({ offer: true, auto: false });
    expect(offerFor(base)).toBe('prompt');
  });

  it('says nothing when there is nothing to offer', () => {
    expect(offerFor({ ...base, located: false })).toBe('none');
    expect(offerFor({ ...base, covered: true })).toBe('none');
    expect(offerFor({ ...base, demo: true })).toBe('none');
    expect(offerFor({ ...base, handled: true })).toBe('none');
    expect(offerFor({ ...base, regions: 0 })).toBe('none');
    expect(offerFor({ ...base, prefs: { offer: false, auto: false } })).toBe('none');
  });

  it('queues without asking only with the opt-in preference, and only online', () => {
    const auto = { offer: true, auto: true };
    expect(offerFor({ ...base, prefs: auto })).toBe('auto');
    // automatic downloads do not need the notice preference
    expect(offerFor({ ...base, prefs: { offer: false, auto: true } })).toBe('auto');
    // once per project: a pack the person removed is not fetched again on the next open
    expect(offerFor({ ...base, prefs: auto, handled: true })).toBe('none');
    expect(offerFor({ ...base, prefs: auto, covered: true })).toBe('none');
    expect(offerFor({ ...base, prefs: auto, demo: true })).toBe('none');
  });

  it('never offers and never queues on an offline-only workstation', () => {
    expect(offerFor({ ...base, offlineOnly: true })).toBe('none');
    expect(offerFor({ ...base, offlineOnly: true, prefs: { offer: true, auto: true } })).toBe(
      'none',
    );
  });
});

describe('prefsOf', () => {
  it('fills the defaults: tell me, and do not download by itself', () => {
    expect(prefsOf(undefined)).toEqual({ offer: true, auto: false });
    expect(prefsOf({})).toEqual({ offer: true, auto: false });
    expect(prefsOf({ auto: true })).toEqual({ offer: true, auto: true });
    expect(prefsOf({ offer: false })).toEqual({ offer: false, auto: false });
  });
});

describe('queueRegions', () => {
  const plan = coveragePlan([{ id: 'p', name: 'Harbour Yard', lonLat: [47.98, 29.37] }], []);
  const regions = chosenRegions(plan);

  it('starts every region through the download channel, in order, as plain regions', async () => {
    const asked: PackRegion[] = [];
    const result = await queueRegions(
      regions,
      (r) => {
        asked.push(r);
        return Promise.resolve({ ok: true });
      },
      false,
    );
    expect(asked.map((r) => r.id)).toEqual(regions.map((r) => r.id));
    // only what `packs:download` takes (its request is strict): no planning notes
    for (const r of asked)
      expect(Object.keys(r).sort()).toEqual(['bbox', 'id', 'label', 'maxZoom']);
    expect(result).toEqual({ started: regions.map((r) => r.id), failed: [] });
  });

  it('asks main for nothing on an offline-only workstation', async () => {
    let calls = 0;
    const result = await queueRegions(
      regions,
      () => {
        calls += 1;
        return Promise.resolve({ ok: true });
      },
      true,
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ started: [], failed: [] });
  });

  it('keeps going past a refused region and reports it with the sentence from main', async () => {
    const result = await queueRegions(
      regions,
      (r) => {
        if (r.id.startsWith('prj-country-'))
          return Promise.resolve({ ok: false, error: 'A map pack is already installed.' });
        if (r.id.startsWith('prj-world-')) return Promise.reject(new Error('The bridge is gone'));
        return Promise.resolve({ ok: true });
      },
      false,
    );
    expect(result.started).toEqual([regions[0]?.id]);
    expect(result.failed).toEqual([
      {
        id: 'prj-country-kuwait-z10',
        label: 'Kuwait overview',
        error: 'A map pack is already installed.',
      },
      { id: 'prj-world-z6', label: 'World overview', error: 'The bridge is gone' },
    ]);
  });

  it('does not start a region that is already in Downloads', async () => {
    const queued = coveragePlan(
      [{ id: 'p', name: 'Harbour Yard', lonLat: [47.98, 29.37] }],
      [],
      [{ id: 'prj-world-z6', state: 'running' }],
    );
    const asked: string[] = [];
    await queueRegions(
      queued.regions,
      (r) => {
        asked.push(r.id);
        return Promise.resolve({ ok: true });
      },
      false,
    );
    expect(asked).not.toContain('prj-world-z6');
    expect(asked).toHaveLength(2);
  });
});

describe('the projects already offered', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
    };
  }

  it('remembers each project once', () => {
    const store = fakeStorage();
    expect(handledProjects(store)).toEqual([]);
    markHandled('p-harbour', store);
    markHandled('p-depot', store);
    markHandled('p-harbour', store);
    expect(handledProjects(store)).toEqual(['p-harbour', 'p-depot']);
  });

  it('reads nothing from broken or blocked storage', () => {
    expect(handledProjects(fakeStorage({ 'quadrion.projectMaps.handled': '{not json' }))).toEqual(
      [],
    );
    expect(handledProjects(fakeStorage({ 'quadrion.projectMaps.handled': '{"a":1}' }))).toEqual([]);
    expect(handledProjects(null)).toEqual([]);
    expect(() => {
      markHandled('p', null);
    }).not.toThrow();
  });
});
