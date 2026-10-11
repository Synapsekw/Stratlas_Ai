// @vitest-environment jsdom
import type { JobRecord } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerList, FINISHED_SHOWN, type DrawerListProps } from './DrawerList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const job = (over: Partial<JobRecord>): JobRecord => ({
  id: `job-${String(++n)}`,
  pipeline: 'photo.products',
  project: 'D:\\Sites\\A',
  status: 'done',
  progress: 1,
  params: {},
  steps: [],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
  ...over,
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function show(over: Partial<DrawerListProps>) {
  const props: DrawerListProps = {
    projectName: 'Site A',
    running: [],
    finished: [],
    elsewhere: [],
    toolsMissing: false,
    now: Date.parse('2026-10-11T09:00:00.000Z'),
    onPick: vi.fn(),
    onCreateMaps: vi.fn(),
    onUpdateTools: vi.fn(),
    ...over,
  };
  act(() => {
    root = createRoot(host);
    root.render(<DrawerList {...props} />);
  });
  return props;
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = (id: string) => [...(q(id)?.querySelectorAll('.job-row') ?? [])];

describe('the processing list of a project', () => {
  it('says so when there is nothing yet, and still offers Create maps', () => {
    const props = show({});
    expect(q('proc-empty')?.textContent).toBe(
      'Nothing is processing in Site A and nothing has finished yet.',
    );
    act(() => q('create-maps')?.click());
    expect(props.onCreateMaps).toHaveBeenCalledTimes(1);
  });

  it('lists running before finished, each row with its kind', () => {
    const run = job({ status: 'running', progress: 0.4 });
    const done = job({ pipeline: 'inspection.run' });
    const props = show({ running: [run], finished: [done] });
    expect(rows('proc-running').map((r) => r.getAttribute('data-job'))).toEqual([run.id]);
    expect(rows('proc-finished').map((r) => r.getAttribute('data-kind'))).toEqual(['ai']);
    expect(q('proc-empty')).toBeNull();
    act(() => {
      (rows('proc-finished')[0] as HTMLButtonElement).click();
    });
    expect(props.onPick).toHaveBeenCalledWith(done.id);
  });

  it('shows the last finished jobs and the rest on Show older', () => {
    const many = Array.from({ length: FINISHED_SHOWN + 3 }, () => job({}));
    show({ finished: many });
    expect(rows('proc-finished')).toHaveLength(FINISHED_SHOWN);
    act(() => q('proc-older')?.click());
    expect(rows('proc-finished')).toHaveLength(FINISHED_SHOWN + 3);
    expect(q('proc-older')).toBeNull();
  });

  it('says when the tools are missing and leads to the update', () => {
    const props = show({ toolsMissing: true });
    expect(q('proc-tools')?.textContent).toContain('Processing cannot run yet');
    act(() => q('proc-tools')?.querySelector('button')?.click());
    expect(props.onUpdateTools).toHaveBeenCalledTimes(1);
  });

  it('names the project of what runs elsewhere', () => {
    const other = job({ project: 'D:\\Sites\\B', status: 'running' });
    show({ elsewhere: [{ job: other, project: 'North quarry' }] });
    expect(rows('proc-elsewhere')[0]?.textContent).toContain('North quarry');
  });

  it('puts the maps from photos under the lists', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <DrawerList
          projectName="Site A"
          running={[]}
          finished={[]}
          elsewhere={[]}
          toolsMissing={false}
          now={0}
          onPick={() => undefined}
          onCreateMaps={() => undefined}
          onUpdateTools={() => undefined}
        >
          <p data-testid="slot">runs</p>
        </DrawerList>,
      );
    });
    expect(q('slot')).not.toBeNull();
  });
});

describe('the processing list without a project of its own', () => {
  it('has no start button and no lists of its own, only what runs elsewhere', () => {
    const other = job({ project: 'D:\\Sites\\B', status: 'running' });
    show({ projectName: null, elsewhere: [{ job: other, project: 'North quarry' }] });
    expect(q('create-maps')).toBeNull();
    expect(q('proc-running')).toBeNull();
    expect(q('proc-finished')).toBeNull();
    expect(q('proc-empty')).toBeNull();
    expect(rows('proc-elsewhere')).toHaveLength(1);
  });

  it('says no project is open when nothing runs anywhere', () => {
    show({ projectName: null });
    expect(q('proc-none')?.textContent).toBe('No project is open.');
  });
});
