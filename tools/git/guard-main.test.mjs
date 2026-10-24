import { describe, expect, it } from 'vitest';
import { pushedRefs, pushRefusal, refusalMessage } from './guard-main.mjs';

const line = (remote) => `refs/heads/x 1111 ${remote} 0000`;
const coordinator = { name: 'aio-software-f2', since: 'today', raw: '' };

describe('guard-main push', () => {
  it('reads the remote refs from pre-push stdin', () => {
    expect(pushedRefs(`${line('refs/heads/feat/a')}\n${line('refs/heads/main')}\n`)).toEqual([
      'refs/heads/feat/a',
      'refs/heads/main',
    ]);
    expect(pushedRefs('')).toEqual([]);
  });

  it('refuses a push to main without the marker, lock or not', () => {
    const input = line('refs/heads/main');
    expect(pushRefusal({ input, allowed: false, coordinator: null })).toBe('a push to main');
    expect(pushRefusal({ input, allowed: false, coordinator })).toBe('a push to main');
    expect(pushRefusal({ input, allowed: true, coordinator })).toBe('');
  });

  it('lets branch pushes through only while no batch is open', () => {
    const input = line('refs/heads/feat/a');
    expect(pushRefusal({ input, allowed: false, coordinator: null })).toBe('');
    expect(pushRefusal({ input, allowed: false, coordinator })).toContain('merge batch is open');
    expect(pushRefusal({ input, allowed: true, coordinator })).toBe('');
    expect(pushRefusal({ input: '', allowed: false, coordinator })).toBe('');
  });

  it('tells the user what to do', () => {
    expect(refusalMessage('a push to main', coordinator)).toContain('SendMessage aio-software-f2');
    expect(refusalMessage('a push to main', null)).toContain('/coordinate');
    expect(refusalMessage('a push to main', null)).not.toContain('orchestrator');
  });
});
