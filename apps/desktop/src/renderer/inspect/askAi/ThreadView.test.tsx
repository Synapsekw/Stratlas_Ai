// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  ask: vi.fn(),
  draft: vi.fn(),
  readOnly: false,
  skip: false,
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => h.readOnly }));
vi.mock('./prefs', () => ({ cloudConfirmSkipped: () => h.skip }));
vi.mock('./thread', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    askThread: createStore(() => ({
      key: null,
      turns: [],
      pending: false,
      error: null,
      route: null,
      confirmed: false,
    })),
    askInThread: h.ask,
    answerToDraft: h.draft,
  };
});

const { ThreadView } = await import('./ThreadView');
const { askThread } = (await import('./thread')) as unknown as {
  askThread: StoreApi<Record<string, unknown>>;
};
const { itemKey } = await import('../../detections/convert');

const manifest = { layers: [] } as unknown as ProjectManifest;
const ITEM = { kind: 'photo' as const, layer: 'photos', photo: 'p1' };
const SONNET = {
  kind: 'cloud' as const,
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5-5',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  h.ask.mockReset();
  h.ask.mockResolvedValue(undefined);
  h.draft.mockReset();
  h.draft.mockResolvedValue('d1');
  h.readOnly = false;
  h.skip = false;
  askThread.setState({
    key: null,
    turns: [],
    pending: false,
    error: null,
    route: null,
    confirmed: false,
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const sel = (id: string) => `[data-testid="${id}"]`;
const q = (id: string) => host.querySelector<HTMLButtonElement>(sel(id));
const area = (id: string) => host.querySelector<HTMLTextAreaElement>(sel(id));
function type(v: string) {
  const el = area('thread-input');
  if (!el) throw new Error('no input');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, v);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (id: string, n = 0) => {
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>(`[data-testid="${id}"]`)[n]?.click();
    await Promise.resolve();
  });
};

function view(onNeedConfirm = vi.fn()) {
  act(() => {
    root.render(
      <ThreadView
        projectId="proj"
        manifest={manifest}
        item={ITEM}
        route={SONNET}
        onNeedConfirm={onNeedConfirm}
      />,
    );
  });
  return onNeedConfirm;
}

const answered = () => {
  act(() => {
    askThread.setState({
      key: itemKey(ITEM),
      turns: [
        { role: 'user', text: 'Which gauge reads highest?' },
        { role: 'assistant', text: 'The left one, at about 6 bar.' },
      ],
      route: SONNET,
      confirmed: true,
    });
  });
};

describe('ThreadView', () => {
  it('asks for the cloud confirm on the first question, then sends it confirmed', async () => {
    const confirm = view();
    type('Which gauge reads highest?');
    await click('thread-send');
    expect(h.ask).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    const [text, send] = confirm.mock.calls[0] as [string, () => void];
    expect(text).toBe('Which gauge reads highest?');
    act(() => {
      send();
    });
    expect(h.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Which gauge reads highest?',
        route: SONNET,
        confirmed: true,
      }),
    );
  });

  it('sends a follow-up without a second confirm', async () => {
    const confirm = view();
    answered();
    expect(host.querySelectorAll('[data-testid="thread-turn-ai"]')).toHaveLength(1);
    expect(q('thread-turn-ai')?.textContent).toContain('Draft');
    type('Write this as a report finding');
    await click('thread-send');
    expect(confirm).not.toHaveBeenCalled();
    expect(h.ask).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Write this as a report finding', item: ITEM }),
    );
    expect(area('thread-input')?.value).toBe('');
  });

  it('Make a finding turns the answer into a draft', async () => {
    view();
    answered();
    await click('thread-make-finding');
    expect(h.draft).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj', item: ITEM, turn: 1 }),
    );
    expect(q('thread-make-finding')).toBeNull();
  });

  it('a read-only package keeps Send and Make a finding off', () => {
    h.readOnly = true;
    view();
    answered();
    expect(q('thread-make-finding')?.disabled).toBe(true);
    expect(q('thread-send')?.disabled).toBe(true);
  });
});
