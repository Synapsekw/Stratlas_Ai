// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineNoticeSeen, onlineSatelliteSwitch, pickBase } from './onlineSatellite';
import { rasterPacks } from './siteTiles';

const g = globalThis as { aio?: unknown };

function fakeAio() {
  const sent: { channel: string; req: unknown }[] = [];
  g.aio = {
    invoke: vi.fn((channel: string, req: { enabled?: boolean; source?: string }) => {
      sent.push({ channel, req });
      if (channel === 'onlineTiles:set')
        return Promise.resolve({
          ok: true,
          enabled: req.enabled ?? true,
          source: req.source ?? 'esri-world-imagery',
        });
      return Promise.resolve(null);
    }),
    on: vi.fn(),
  };
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  rasterPacks.getState().setForSession({ onlineSatellite: false });
});
afterEach(() => {
  onlineSatelliteSwitch.getState().cancel();
  delete g.aio;
});

describe('one notice per provider', () => {
  it('counts the notice of 0.11 as the EOX one only', () => {
    localStorage.setItem('stratlas.onlineSatelliteNotice', '1');
    expect(onlineNoticeSeen('eox')).toBe(true);
    expect(onlineNoticeSeen()).toBe(true);
    expect(onlineNoticeSeen('esri')).toBe(false);
  });

  it('picking Esri the first time asks, and switches online maps on with Esri only on yes', async () => {
    const sent = fakeAio();
    const apply = vi.fn();
    pickBase('esri-world-imagery', apply);
    expect(onlineSatelliteSwitch.getState().asking).toBe('esri-world-imagery');
    expect(sent).toEqual([]);
    onlineSatelliteSwitch.getState().confirm();
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledWith('esri-world-imagery');
    });
    expect(sent).toEqual([
      { channel: 'onlineTiles:set', req: { enabled: true, source: 'esri-world-imagery' } },
    ]);
    expect(onlineNoticeSeen('esri')).toBe(true);
    expect(onlineNoticeSeen('mapbox')).toBe(false);
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(true);
  });

  it('a Mapbox style switches online maps on and keeps the online satellite as it was', async () => {
    const sent = fakeAio();
    localStorage.setItem('stratlas.onlineNotice.mapbox', '1');
    const apply = vi.fn();
    pickBase('mapbox-dark', apply);
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledWith('mapbox-dark');
    });
    expect(sent[0]?.req).toEqual({ enabled: true });
  });

  it('Cancel switches nothing on and applies nothing', () => {
    fakeAio();
    const apply = vi.fn();
    pickBase('mapbox-satellite', apply);
    onlineSatelliteSwitch.getState().cancel();
    expect(apply).not.toHaveBeenCalled();
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
  });

  it('an offline base map is applied at once, and so is a source already allowed', () => {
    const apply = vi.fn();
    pickBase('streets', apply);
    expect(apply).toHaveBeenLastCalledWith('streets');
    localStorage.setItem('stratlas.onlineNotice.esri', '1');
    rasterPacks.getState().setForSession({ onlineSatellite: true });
    pickBase('esri-world-imagery', apply);
    expect(apply).toHaveBeenLastCalledWith('esri-world-imagery');
  });
});
