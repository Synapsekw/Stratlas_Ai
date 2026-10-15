// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reloads: [] as [string, boolean][], created: [] as string[] }));
vi.mock('../classes/store', () => ({
  createClass: (label: string) => {
    h.created.push(label);
    if (label === 'bad') return Promise.reject(new Error('Classes not saved: disk full'));
    return Promise.resolve({ id: 'spalling', label, color: '#7cc46b', severityModel: 'sev' });
  },
}));
vi.mock('./store', () => ({
  loadDetections: (id: string, force: boolean) => {
    h.reloads.push([id, force]);
    return Promise.resolve();
  },
}));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() }, useCall: vi.fn() }));

const { createClassFromLabel } = await import('./createFromLabel');
const { mapModelClass } = await import('./LocalDetect');

beforeEach(() => {
  h.reloads = [];
  h.created = [];
  window.localStorage.clear();
  workspace.setState({ project: { id: 'p', root: '/p', manifest: {} as never }, issues: [] });
});

describe('Create class from a detection word', () => {
  it('creates the class, maps the local model word, and reads the detections again', async () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.yolo',
      JSON.stringify({ Spalling: '', crack: 'crack' }),
    );
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.other',
      JSON.stringify({ spalling: 'rust' }),
    );
    expect(await createClassFromLabel('Spalling')).toBeNull();
    expect(h.created).toEqual(['Spalling']);
    expect(h.reloads).toEqual([['p', true]]);
    expect(
      JSON.parse(window.localStorage.getItem('stratlas.detect.classMap.p.yolo') ?? ''),
    ).toEqual({
      Spalling: 'spalling',
      crack: 'crack',
    });
    // a word mapped to a class on purpose is left alone
    expect(
      JSON.parse(window.localStorage.getItem('stratlas.detect.classMap.p.other') ?? ''),
    ).toEqual({
      spalling: 'rust',
    });
  });

  it('reports a refused create and reads nothing', async () => {
    expect(await createClassFromLabel('bad')).toBe('Classes not saved: disk full');
    expect(h.reloads).toEqual([]);
  });

  it('mapModelClass ignores other projects and unreadable entries', () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.q.yolo',
      JSON.stringify({ Spalling: '' }),
    );
    window.localStorage.setItem('stratlas.detect.classMap.p.broken', '{');
    mapModelClass('p', 'Spalling', 'spalling');
    expect(window.localStorage.getItem('stratlas.detect.classMap.q.yolo')).toBe('{"Spalling":""}');
    expect(window.localStorage.getItem('stratlas.detect.classMap.p.broken')).toBe('{');
  });
});
