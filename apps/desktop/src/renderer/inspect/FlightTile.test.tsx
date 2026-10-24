// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectClip } from '../workspace/pickClip';
import { flightCards } from '../screens/mediaModel';
import { FlightTile } from './FlightTile';

vi.mock('../workspace/pickClip', () => ({ selectClip: vi.fn() }));
vi.mock('../thumbs/Thumb', () => ({ MediaThumb: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = (id: string, offsetMs: number): Layer => ({
  kind: 'video',
  id,
  name: `Flight 1 · clip ${id}`,
  visible: true,
  src: { path: `video/${id}.mp4` },
  flight: { src: { path: 'flights/f1.json' }, startUtcMs: 0 },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs,
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  vi.mocked(selectClip).mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function show(layers: Layer[], onOpen = vi.fn()) {
  const [flight] = flightCards(layers, {});
  if (!flight) throw new Error('no flight');
  act(() =>
    root?.render(
      <FlightTile flight={flight} projectId="p" open={false} playing={false} onOpen={onOpen} />,
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>('.m-flight-main')?.click());
  return onOpen;
}

describe('a flight card', () => {
  it('plays a one-clip flight when its card is clicked: the card is that clip', () => {
    const onOpen = show([clip('a', 0)]);
    expect(selectClip).toHaveBeenCalledWith('a');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the clip list of a flight with several clips', () => {
    const onOpen = show([clip('a', 0), clip('b', 60_000)]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(selectClip).not.toHaveBeenCalled();
  });
});
