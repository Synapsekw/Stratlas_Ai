import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { connectionStatus, type ConnectionInput } from './connection';

const BOOL = [false, true];
const ALL: ConnectionInput[] = BOOL.flatMap((offlineOnly) =>
  BOOL.flatMap((cloudAi) => BOOL.map((pkgBlocked) => ({ offlineOnly, cloudAi, pkgBlocked }))),
);

const words = (i: ConnectionInput) => {
  const s = connectionStatus(i);
  return `${t(s.modeLabel)} + ${t(s.cloudLabel)}`;
};

describe('connectionStatus', () => {
  it('names the pair for every combination of the two switches and the package', () => {
    const on = true;
    const off = false;
    expect(words({ offlineOnly: off, cloudAi: on, pkgBlocked: off })).toBe('Online + Cloud AI');
    expect(words({ offlineOnly: off, cloudAi: off, pkgBlocked: off })).toBe(
      'Online + Cloud AI off',
    );
    expect(words({ offlineOnly: off, cloudAi: on, pkgBlocked: on })).toBe(
      'Online + Cloud AI blocked',
    );
    expect(words({ offlineOnly: off, cloudAi: off, pkgBlocked: on })).toBe('Online + Cloud AI off');
    expect(words({ offlineOnly: on, cloudAi: on, pkgBlocked: off })).toBe(
      'Offline only + Cloud AI blocked',
    );
    expect(words({ offlineOnly: on, cloudAi: off, pkgBlocked: off })).toBe(
      'Offline only + Cloud AI off',
    );
    expect(words({ offlineOnly: on, cloudAi: on, pkgBlocked: on })).toBe(
      'Offline only + Cloud AI blocked',
    );
    expect(words({ offlineOnly: on, cloudAi: off, pkgBlocked: on })).toBe(
      'Offline only + Cloud AI off',
    );
  });

  it('never shows cloud AI as on while offline only, or while the package forbids it', () => {
    for (const i of ALL) {
      const s = connectionStatus(i);
      // the mode is the offline-only switch and nothing else
      expect(s.mode, JSON.stringify(i)).toBe(i.offlineOnly ? 'offline' : 'online');
      // cloud AI is live only when it is switched on and nothing stops it
      expect(s.cloudActive, JSON.stringify(i)).toBe(i.cloudAi && !i.offlineOnly && !i.pkgBlocked);
      expect(s.cloud === 'on', JSON.stringify(i)).toBe(s.cloudActive);
      if (s.mode === 'offline') {
        expect(t(s.cloudLabel), JSON.stringify(i)).not.toBe('Cloud AI');
        expect(s.cloudStoppedBy).toBe('offline');
      }
      // "blocked" means the person switched it on and something else stops it
      expect(s.cloud === 'blocked', JSON.stringify(i)).toBe(
        i.cloudAi && (i.offlineOnly || i.pkgBlocked),
      );
    }
  });

  it('says in the tip what stops cloud AI: offline only first, then the package', () => {
    const tip = (i: ConnectionInput) => t(connectionStatus(i).cloudTip);
    for (const cloudAi of BOOL) {
      for (const pkgBlocked of BOOL)
        expect(tip({ offlineOnly: true, cloudAi, pkgBlocked })).toContain('offline-only');
      // a package that forbids cloud AI keeps its own tip, whatever the switch says
      expect(tip({ offlineOnly: false, cloudAi, pkgBlocked: true })).toBe(
        'This package does not allow cloud AI. Nothing is sent to any provider.',
      );
    }
    expect(tip({ offlineOnly: false, cloudAi: true, pkgBlocked: false })).toContain('allowed');
    expect(tip({ offlineOnly: false, cloudAi: false, pkgBlocked: false })).toContain('is off');
  });

  it('gives each mode its own icon, label and tip', () => {
    const online = connectionStatus({ offlineOnly: false, cloudAi: false, pkgBlocked: false });
    const offline = connectionStatus({ offlineOnly: true, cloudAi: false, pkgBlocked: false });
    expect([online.modeIcon, offline.modeIcon]).toEqual(['globe', 'offline']);
    expect(t(online.modeTip)).toContain('Online');
    expect(t(offline.modeTip)).toContain('no network connections');
    expect([t(online.cloudWord), t(offline.cloudWord)]).toEqual(['Off', 'Off']);
    expect(
      t(connectionStatus({ offlineOnly: true, cloudAi: true, pkgBlocked: false }).cloudWord),
    ).toBe('Blocked');
    expect(
      t(connectionStatus({ offlineOnly: false, cloudAi: true, pkgBlocked: false }).cloudWord),
    ).toBe('On');
  });
});
