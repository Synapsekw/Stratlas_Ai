// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectorPasses } from './DetectorPasses';
import { detectorPassRows } from './passRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const row = {
  pass: 'vlm-run-a.json',
  detectorName: 'Rust patch',
  runAt: '2026-10-20T09:00:00Z',
  threshold: 0.5,
  shown: 7,
  hidden: 3,
};

describe('DetectorPasses', () => {
  it('shows each pass with shown and hidden counts', () => {
    const second = { ...row, pass: 'vlm-run-b.json', detectorName: 'Crack', shown: 1, hidden: 0 };
    act(() => {
      root.render(<DetectorPasses passes={[row, second]} onThreshold={() => undefined} />);
    });
    const passes = [...host.querySelectorAll('[data-testid="det-vlm-pass"]')];
    expect(passes).toHaveLength(2);
    expect(passes[0]?.textContent).toContain('Rust patch');
    expect(passes[0]?.textContent).toContain('7 shown, 3 hidden');
    expect(passes[1]?.textContent).toContain('1 shown, 0 hidden');
  });

  it('calls onThreshold with the pass and the new value when a slider moves', () => {
    const onThreshold = vi.fn();
    act(() => {
      root.render(<DetectorPasses passes={[row]} onThreshold={onThreshold} />);
    });
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]');
    expect(slider?.value).toBe('0.5');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        slider,
        '0.6',
      );
      slider?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onThreshold).toHaveBeenCalledWith('vlm-run-a.json', 0.6);
  });

  it('keeps the slider keys to the slider, so the review does not step', () => {
    const reviewKey = vi.fn();
    act(() => {
      root.render(
        <div onKeyDown={reviewKey}>
          <DetectorPasses passes={[row]} onThreshold={() => undefined} />
        </div>,
      );
    });
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]');
    const down = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      slider?.dispatchEvent(down);
    });
    expect(reviewKey).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(false);
  });
});

const model = (
  id: string,
  pass: string,
  confidence: number | undefined,
  threshold: number,
  extra: Partial<Detection> = {},
): Detection =>
  ({
    id,
    pass,
    status: 'draft',
    ...(confidence === undefined ? {} : { confidence }),
    origin: {
      kind: 'model',
      producer: 'x',
      detector: { id: `det-${pass}`, version: 1, modelSha256: 'a'.repeat(64), threshold },
    },
    ...extra,
  }) as unknown as Detection;

describe('detectorPassRows', () => {
  it('counts shown and hidden by the same bar the queue uses; unscored always shows', () => {
    const list = [
      model('a', 'vlm-1.json', 0.9, 0.6),
      model('b', 'vlm-1.json', 0.5, 0.6),
      model('c', 'vlm-1.json', undefined, 0.6, { unscored: true }),
      model('d', 'vlm-1.json', 0.4, 0.6, { status: 'rejected' }),
    ];
    const [r] = detectorPassRows(list, new Map(), {});
    expect(r).toMatchObject({ shown: 2, hidden: 1, threshold: 0.6 });
    const [moved] = detectorPassRows(list, new Map(), { 'vlm-1.json': 0.4 });
    expect(moved).toMatchObject({ shown: 3, hidden: 0, threshold: 0.4 });
  });

  it('names the detectors from the pass header, joined, else from the candidates', () => {
    const header = {
      createdAt: '2026-10-20T09:00:00Z',
      detectors: ['Rust', 'Crack'].map((name, i) => ({
        id: `d${String(i)}`,
        version: 1,
        classId: 'c',
        name,
        threshold: i === 0 ? 0.7 : 0.55,
        modelSha256: 'a'.repeat(64),
      })),
    };
    const list = [model('a', 'vlm-1.json', 0.9, 0.7)];
    const [a] = detectorPassRows(list, new Map([['vlm-1.json', header]]), {});
    expect(a?.detectorName).toBe('Rust, Crack');
    expect(a?.threshold).toBe(0.55);
    expect(a?.runAt).toBe('2026-10-20T09:00:00Z');
    const [b] = detectorPassRows(list, new Map(), {});
    expect(b?.detectorName).toBe('det-vlm-1.json');
  });

  it('keeps a bar outside the slider range at the slider end, so label and slider agree', () => {
    const low = [model('a', 'vlm-1.json', 0.9, 0.1)];
    expect(detectorPassRows(low, new Map(), {})[0]?.threshold).toBe(0.3);
    expect(detectorPassRows(low, new Map(), { 'vlm-1.json': 0.99 })[0]?.threshold).toBe(0.95);
  });

  it('leaves out passes that are not local-detector passes', () => {
    expect(detectorPassRows([model('a', 'ai-1.json', 0.9, 0.5)], new Map(), {})).toEqual([]);
  });
});
