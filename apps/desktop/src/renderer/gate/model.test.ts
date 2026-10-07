import type { Identity } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  gateAtStart,
  gateWanted,
  greetingFor,
  LAUNCH_HINT_KEY,
  orgLine,
  readLaunchHint,
  writeLaunchHint,
} from './model';

const identity = (over: Partial<Identity> = {}): Identity => ({
  schema: 'aio.identity/1',
  actor: 'a_0123456789abcdefghijklmnop',
  name: 'Rana Example',
  initials: 'RE',
  createdAt: '2026-10-08T08:00:00.000Z',
  migratedFrom: 'author-setting',
  ...over,
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('whether the launch screen shows', () => {
  it('shows on a normal start, also before the setting was ever written', () => {
    expect(gateAtStart('auto', null)).toBe(true);
    expect(gateAtStart('auto', '1')).toBe(true);
    expect(gateWanted({})).toBe(true);
    expect(gateWanted({ launchScreen: true })).toBe(true);
  });

  it('stays away when Settings switch it off', () => {
    expect(gateWanted({ launchScreen: false })).toBe(false);
    // the mirrored switch spares the next start even the first frame
    expect(gateAtStart('auto', '0')).toBe(false);
  });

  it('never shows in an automated run', () => {
    expect(gateAtStart('skip', null)).toBe(false);
    expect(gateAtStart('skip', '1')).toBe(false);
  });

  it('mirrors the switch in local storage, and survives storage that throws', () => {
    const s = memoryStorage();
    expect(readLaunchHint(s)).toBeNull();
    writeLaunchHint(s, false);
    expect(s.getItem(LAUNCH_HINT_KEY)).toBe('0');
    expect(readLaunchHint(s)).toBe('0');
    writeLaunchHint(s, true);
    expect(readLaunchHint(s)).toBe('1');
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readLaunchHint(broken)).toBeNull();
    expect(() => {
      writeLaunchHint(broken, true);
    }).not.toThrow();
    expect(readLaunchHint(null)).toBeNull();
  });
});

describe('whom it greets', () => {
  it("greets the identity's own name", () => {
    expect(greetingFor(identity(), true)).toEqual({ kind: 'named', name: 'Rana Example' });
    expect(greetingFor(identity({ migratedFrom: 'os-account', name: 'rana' }), true)).toEqual({
      kind: 'named',
      name: 'rana',
    });
  });

  it('waits for the identity, then greets without a name', () => {
    expect(greetingFor(null, false)).toEqual({ kind: 'pending' });
    expect(greetingFor(null, true)).toEqual({ kind: 'anonymous' });
  });

  it("never greets main's placeholder as if it were a name", () => {
    expect(greetingFor(identity({ migratedFrom: 'new', name: 'Reviewer' }), true)).toEqual({
      kind: 'anonymous',
    });
    // a person who then set their name is greeted by it
    expect(greetingFor(identity({ migratedFrom: 'new', name: 'Omar Sample' }), true)).toEqual({
      kind: 'named',
      name: 'Omar Sample',
    });
  });
});

describe('the line under the name', () => {
  it('names the company from report branding, then this computer', () => {
    expect(orgLine({ reportBranding: { companyName: 'Synapse Solutions' } }, 'this computer')).toBe(
      'Synapse Solutions · this computer',
    );
  });

  it('is only this computer without a company', () => {
    expect(orgLine({}, 'this computer')).toBe('this computer');
    expect(orgLine({ reportBranding: { companyName: '  ' } }, 'this computer')).toBe(
      'this computer',
    );
  });
});
