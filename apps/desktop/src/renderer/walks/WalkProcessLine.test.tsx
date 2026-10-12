// @vitest-environment jsdom
import { WALK_SCHEMA, type WalkFile } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkStatus } from './walkModel';
import { WalkProcessLine, type WalkProcessLineProps } from './WalkProcessLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (layout: WalkFile['source']['layout']): WalkFile => ({
  schema: WALK_SCHEMA,
  id: 'vid-1',
  name: 'Site tour',
  createdAt: '2026-10-11T08:00:00.000Z',
  source: {
    file: 'VID_1.insv',
    layout,
    streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }],
  },
  video: {
    src: 'walks/vid-1/playback.mp4',
    width: 256,
    height: 128,
    durationS: 1,
    fps: 30,
    audio: false,
  },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

function mount(over: Partial<WalkProcessLineProps> = {}) {
  const props: WalkProcessLineProps = {
    layerId: 'walk-vid-1',
    record: record('insv-dual-stream'),
    status: { kind: 'not-processed' },
    offered: true,
    readOnly: false,
    onProcess: vi.fn(() => Promise.resolve(null)),
    onLocate: vi.fn(() => Promise.resolve(null)),
    ...over,
  };
  act(() => {
    root.render(<WalkProcessLine {...props} />);
  });
  const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { props, q };
}

const click = async (el: HTMLElement | null) => {
  await act(async () => {
    el?.click();
    await Promise.resolve();
  });
};

describe('WalkProcessLine', () => {
  it.each<[WalkStatus, string]>([
    [{ kind: 'not-processed' }, 'Not processed'],
    [{ kind: 'processing', pct: 42, jobId: 'j' }, 'Processing 42 %'],
    [{ kind: 'processed', source: 'sfm' }, 'Processed'],
    [{ kind: 'processed', source: 'pins-only' }, 'Processed, path from pins only'],
    [{ kind: 'failed', message: 'No frames.' }, 'Processing failed: No frames.'],
  ])('says where the walk stands: %j', (status, text) => {
    const { q } = mount({ status });
    const line = q('walk-status-walk-vid-1');
    expect(line?.dataset.kind).toBe(status.kind);
    expect(line?.querySelector('.walk-proc-text')?.textContent).toBe(text);
  });

  it('offers Process walk for a walk not processed or whose processing failed', () => {
    expect(mount().q('walk-process-walk-vid-1')?.textContent).toBe('Process walk');
    expect(
      mount({ status: { kind: 'failed', message: 'x' } }).q('walk-process-walk-vid-1'),
    ).not.toBeNull();
    expect(
      mount({ status: { kind: 'processed', source: 'sfm' } }).q('walk-process-walk-vid-1'),
    ).toBeNull();
    expect(
      mount({ status: { kind: 'processing', pct: 1, jobId: 'j' } }).q('walk-process-walk-vid-1'),
    ).toBeNull();
  });

  it('greys Process walk with the reason when the pipeline pack is too old', () => {
    const { q } = mount({ offered: false });
    const button = q('walk-process-walk-vid-1') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(host.textContent).toContain('Needs a newer pipeline pack');
  });

  it('offers nothing in a read-only package', () => {
    const { q } = mount({ readOnly: true });
    expect(q('walk-process-walk-vid-1')).toBeNull();
    expect(q('walk-status-walk-vid-1')).not.toBeNull();
  });

  it('processes a stitched video straight away: it is its own original', async () => {
    const { q, props } = mount({ record: record('equirect') });
    await click(q('walk-process-walk-vid-1'));
    expect(props.onProcess).toHaveBeenCalledWith(undefined);
    expect(q('walk-locate-walk-vid-1')).toBeNull();
  });

  it('asks for the original of a camera file, or processes without it', async () => {
    const { q, props } = mount();
    await click(q('walk-process-walk-vid-1'));
    const choice = q('walk-locate-walk-vid-1');
    expect(choice?.textContent).toContain('Locate the original of Site tour');
    await click(q('walk-locate-without'));
    expect(props.onProcess).toHaveBeenCalledWith(undefined);
    expect(q('walk-locate-walk-vid-1')).toBeNull();
  });

  it('processes from the located original, and says so when another file was picked', async () => {
    const onLocate = vi
      .fn<WalkProcessLineProps['onLocate']>()
      .mockResolvedValueOnce({ error: 'VID_2.insv is not VID_1.insv.' })
      .mockResolvedValueOnce({ path: 'D:/cam/VID_1.insv' });
    const { q, props } = mount({ onLocate });
    await click(q('walk-process-walk-vid-1'));
    await click(q('walk-locate-pick'));
    expect(q('walk-locate-walk-vid-1')?.textContent).toContain('VID_2.insv is not VID_1.insv.');
    expect(props.onProcess).not.toHaveBeenCalled();
    await click(q('walk-locate-pick'));
    expect(props.onProcess).toHaveBeenCalledWith('D:/cam/VID_1.insv');
  });
});
