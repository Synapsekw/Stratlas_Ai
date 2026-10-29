// @vitest-environment jsdom
import { AiRequest, type ProjectManifest } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Custom from './custom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Status {
  cloud: { usable: boolean; providers: ('anthropic' | 'openai')[]; message?: string };
  keepLocal: boolean;
  local: { ready: boolean; problem?: string };
}

const h = vi.hoisted(() => {
  const answers: Record<string, unknown> = {};
  const status: unknown = null;
  const spot: unknown = null;
  return {
    answers,
    call: vi.fn(),
    start: vi.fn(),
    openSettingsPage: vi.fn(),
    readOnly: false,
    status,
    spot,
    skip: false,
  };
});

vi.mock('../../shell', () => ({
  useCall: (channel: string) => h.answers[channel] ?? null,
  bridge: { call: h.call },
  shell: { getState: () => ({ openSettingsPage: h.openSettingsPage }) },
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => h.readOnly }));
vi.mock('../../author', () => ({ authorName: () => 'tester' }));
vi.mock('./runs', () => ({
  startAskRun: h.start,
  useAskAiRun: (sel: (s: { run: unknown }) => unknown) => sel({ run: null }),
}));
vi.mock('./prefs', () => ({
  askAiPrefs: { getState: () => ({ backend: 'auto', localModel: null, cloudBatch: 4 }) },
  cloudConfirmSkipped: () => h.skip,
}));
vi.mock('./custom', async (orig) => ({
  ...(await orig<typeof Custom>()),
  useAskStatus: () => h.status,
  askConfirmInfo: () => ({ provider: 'anthropic', model: 'claude-haiku-5-5' }),
}));
vi.mock('./CloudConfirm', () => ({
  CloudConfirm: (p: { onSend: () => void }) => (
    <button type="button" data-testid="cloud-send" onClick={p.onSend}>
      send
    </button>
  ),
}));
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
    askInThread: vi.fn(() => Promise.resolve()),
    answerToDraft: vi.fn(() => Promise.resolve('d1')),
  };
});
vi.mock('../../workspace/spot/useSpotHistory', () => ({ useSpotHistory: () => h.spot }));

const { AskPanel } = await import('./AskPanel');

const manifest = {
  layers: [{ kind: 'photos', id: 'photos', name: 'Photos', items: [{ id: 'p1' }, { id: 'p2' }] }],
  classCatalogues: [
    {
      id: 'cat',
      assetType: 'asset',
      classes: [{ id: 'gauge', label: 'Gauge', severityModel: 'sev' }],
    },
  ],
  severityModels: [{ id: 'sev', name: 'S', levels: [{ value: 1, label: 'Low' }] }],
} as unknown as ProjectManifest;
const P1: PhotoPick = { layerId: 'photos', photoId: 'p1' };
const P2: PhotoPick = { layerId: 'photos', photoId: 'p2' };

const READY: Status = {
  cloud: { usable: true, providers: ['anthropic'] },
  keepLocal: false,
  local: { ready: true },
};
const CLOUD_ONLY: Status = { ...READY, local: { ready: false, problem: 'No model.' } };
const NOTHING: Status = {
  cloud: { usable: false, providers: [], message: 'Cloud AI is off.' },
  keepLocal: false,
  local: { ready: false, problem: 'The Analytics pack is not installed.' },
};

const SAVED: AiRequest = {
  schema: 'aio.ai-request/1',
  id: 'gauges-abc123',
  name: 'Gauges',
  kind: 'find',
  prompt: 'read all gauges',
  fields: [{ key: 'reading', label: 'Reading', type: 'number', unit: 'bar' }],
  scope: 'all',
  model: 'auto',
  author: 'tester',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:00:00.000Z',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  h.answers = { 'requests:list': { ok: true, value: { items: [], problems: [] } } };
  h.call.mockReset();
  h.call.mockResolvedValue({ ok: true, value: { ok: true } });
  h.start.mockReset();
  h.start.mockResolvedValue(undefined);
  h.openSettingsPage.mockReset();
  h.readOnly = false;
  h.status = READY;
  h.spot = { index: null, tags: {}, result: null, origin: undefined };
  h.skip = false;
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const sel = (id: string) => `[data-testid="${id}"]`;
const q = (id: string) => host.querySelector<HTMLButtonElement>(sel(id));
const input = (id: string) => host.querySelector<HTMLInputElement>(sel(id));
const area = (id: string) => host.querySelector<HTMLTextAreaElement>(sel(id));
const select = (id: string) => host.querySelector<HTMLSelectElement>(sel(id));
const text = (id: string) => q(id)?.textContent ?? '';
const click = async (id: string) => {
  await act(async () => {
    q(id)?.click();
    await Promise.resolve();
  });
};
function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  v: string,
) {
  if (!el) throw new Error('no element');
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
  act(() => {
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

function panel(p: { current?: PhotoPick | null } = {}) {
  act(() => {
    root.render(
      <AskPanel
        projectId="proj"
        projectRoot="C:/proj"
        manifest={manifest}
        current={p.current === undefined ? P1 : p.current}
        selected={[]}
        all={[P1, P2]}
        onClose={() => undefined}
      />,
    );
  });
}

describe('AskPanel', () => {
  it('builds the request from the editor: a reading value gives key reading', async () => {
    panel();
    setValue(area('ask-prompt'), 'read all gauges');
    await click('field-add');
    setValue(input('field-label-0'), 'Reading');
    await click('ask-run');
    expect(h.start).toHaveBeenCalledTimes(1);
    const started = h.start.mock.calls[0]?.[0] as {
      items: unknown[];
      custom: { request: { prompt: string; fields: { key: string }[] }; route: unknown };
    };
    expect(started.custom.request.prompt).toBe('read all gauges');
    expect(started.custom.request.fields.map((f) => f.key)).toEqual(['reading']);
    expect(started.custom.route).toEqual({ kind: 'local' });
    expect(started.items).toEqual([{ kind: 'photo', layer: 'photos', photo: 'p1' }]);
  });

  it('routes a find on this photo to this PC, and All photos to Claude Haiku 5.5', async () => {
    panel();
    expect(text('ask-model')).toBe('Runs on this PC');
    await click('ask-scope-all');
    expect(text('ask-model')).toBe('Runs on Claude Haiku 5.5');
    // compare dates and ask go to the strong model
    await click('ask-kind-ask');
    expect(text('ask-model')).toBe('Runs on Claude Sonnet 5.5');
  });

  it('shows the cloud confirm before a cloud run, and Send starts it with the request', async () => {
    h.status = CLOUD_ONLY;
    panel();
    setValue(area('ask-prompt'), 'find all gauges');
    await click('ask-run');
    expect(h.start).not.toHaveBeenCalled();
    expect(q('cloud-send')).not.toBeNull();
    await click('cloud-send');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({
      confirmed: true,
      custom: {
        request: { kind: 'find', prompt: 'find all gauges' },
        route: { kind: 'cloud', provider: 'anthropic', model: 'claude-haiku-5-5' },
      },
    });
  });

  it('starts a cloud run at once when the project said Do not ask again', async () => {
    h.status = CLOUD_ONLY;
    h.skip = true;
    panel();
    setValue(area('ask-prompt'), 'find all gauges');
    await click('ask-run');
    expect(q('cloud-send')).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('keeps cloud models off for a project that keeps its images on this PC', () => {
    h.status = { ...READY, keepLocal: true };
    panel();
    expect(text('ask-note-local')).toContain('This project keeps its images on this PC.');
    const options = [...(select('ask-model-pick')?.options ?? [])];
    const cloud = options.filter((o) => o.value.includes(':'));
    expect(cloud.length).toBeGreaterThan(0);
    for (const o of cloud) expect(o.disabled).toBe(true);
    expect(options.find((o) => o.value === 'local')?.disabled).toBe(false);
    // auto stays on this PC even for every photo
    expect(text('ask-model')).toBe('Runs on this PC');
  });

  it('nothing can run: says why, links to Settings and keeps Run off', async () => {
    h.status = NOTHING;
    panel();
    setValue(area('ask-prompt'), 'find all gauges');
    expect(text('ask-note-none')).toContain('Nothing can run this request.');
    expect(text('ask-note-none')).toContain('The Analytics pack is not installed.');
    expect(q('ask-run')?.disabled).toBe(true);
    await click('ask-settings');
    expect(h.openSettingsPage).toHaveBeenCalledWith('ai');
  });

  it('says compare dates and written answers are weaker on this PC', async () => {
    h.status = { ...READY, cloud: { usable: false, providers: [] } };
    panel();
    expect(q('ask-note-weak')).toBeNull();
    await click('ask-kind-change');
    expect(text('ask-note-weak')).toBe(
      'Comparing dates and written answers are weaker on this PC than in the cloud.',
    );
  });

  it('compare dates says why when spot history has no other date', async () => {
    h.spot = {
      index: { captures: [{ id: 'c1' }] },
      tags: {},
      result: { history: { spot: {}, dates: [{ capture: 'c1', matches: [], skipped: 0 }] } },
      origin: 'c1',
    };
    panel();
    await click('ask-kind-change');
    setValue(area('ask-prompt'), 'what changed');
    expect(text('ask-dates-none')).toBe('No other survey date has a photo of this spot.');
    expect(q('ask-run')?.disabled).toBe(true);
  });

  it('compare dates says when the photo has no position', async () => {
    h.spot = {
      index: { captures: [{ id: 'c1' }, { id: 'c2' }] },
      tags: {},
      result: { error: 'noPosition' },
      origin: 'c2',
    };
    panel();
    await click('ask-kind-change');
    expect(q('ask-dates-noposition')).not.toBeNull();
  });

  it('compare dates runs the older date as Image 1 and the photo in view as Image 2', async () => {
    h.spot = {
      index: { captures: [{ id: 'c1' }, { id: 'c2' }] },
      tags: { c1: { long: '3 Mar 2026', short: 'Mar' }, c2: { long: '9 Sep 2026', short: 'Sep' } },
      result: {
        history: {
          spot: {},
          dates: [
            {
              capture: 'c1',
              matches: [{ item: { kind: 'photo', layer: 'old', photo: 'o1' }, distanceM: 3.4 }],
              skipped: 0,
            },
            {
              capture: 'c2',
              matches: [{ item: { kind: 'photo', layer: 'photos', photo: 'p1' }, distanceM: 0 }],
              skipped: 0,
            },
          ],
        },
      },
      origin: 'c2',
    };
    panel();
    await click('ask-kind-change');
    setValue(area('ask-prompt'), 'what changed');
    expect(text('ask-date-c1')).toContain('3 Mar 2026');
    expect(text('ask-date-c1')).toContain('3 m away');
    expect(q('ask-date-c2')).toBeNull();
    await click('ask-date-c1');
    await click('ask-run');
    // compare dates goes to Sonnet: the confirm first
    await click('cloud-send');
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({
      custom: {
        request: { kind: 'change' },
        pair: {
          before: { kind: 'photo', layer: 'old', photo: 'o1' },
          after: { kind: 'photo', layer: 'photos', photo: 'p1' },
          labels: ['3 Mar 2026', '9 Sep 2026'],
        },
      },
    });
  });

  it('Save asks for a name inline and saves a valid request', async () => {
    panel();
    setValue(area('ask-prompt'), 'read all gauges');
    await click('field-add');
    setValue(input('field-label-0'), 'Reading');
    await click('ask-usecase-save');
    setValue(input('ask-usecase-name'), 'Gauge readings');
    await click('ask-usecase-name-ok');
    const save = h.call.mock.calls.find((c) => c[0] === 'requests:save');
    expect(save).toBeDefined();
    const req = save?.[1] as { projectId: string; where: string; request: unknown };
    expect(req.projectId).toBe('proj');
    expect(req.where).toBe('project');
    const parsed = AiRequest.safeParse(req.request);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      name: 'Gauge readings',
      kind: 'find',
      prompt: 'read all gauges',
      scope: 'photo',
      model: 'auto',
      author: 'tester',
      fields: [{ key: 'reading', label: 'Reading', type: 'text' }],
    });
  });

  it('picking a saved request fills the editor', () => {
    h.answers['requests:list'] = {
      ok: true,
      value: { items: [{ where: 'library', request: SAVED }], problems: [] },
    };
    panel();
    setValue(select('ask-usecase'), 'library:gauges-abc123');
    expect(area('ask-prompt')?.value).toBe('read all gauges');
    expect(input('field-label-0')?.value).toBe('Reading');
    expect(input('field-unit-0')?.value).toBe('bar');
    expect(q('ask-scope-all')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('ask-usecase-export')?.disabled).toBe(false);
  });

  it('starts a new request with no choices left over from the one before', async () => {
    h.answers['requests:list'] = {
      ok: true,
      value: {
        items: [
          {
            where: 'project',
            request: {
              ...SAVED,
              fields: [{ key: 'state', label: 'State', type: 'choice', choices: ['ok', 'worn'] }],
            },
          },
        ],
        problems: [],
      },
    };
    panel();
    setValue(select('ask-usecase'), 'project:gauges-abc123');
    setValue(input('field-choices-0'), 'ok, worn,');
    expect(input('field-choices-0')?.value).toBe('ok, worn,');
    await click('ask-usecase-new');
    await click('field-add');
    setValue(select('field-type-0'), 'choice');
    expect(input('field-choices-0')?.value).toBe('');
  });

  it('says why Run is off with no photo open', () => {
    panel({ current: null });
    setValue(area('ask-prompt'), 'find all gauges');
    expect(text('ask-no-photo')).toBe('Open a photo first, or look at Selected or All photos.');
    expect(q('ask-run')?.disabled).toBe(true);
  });

  it('asks for the other date before a compare can run', async () => {
    h.spot = {
      index: { captures: [{ id: 'c1' }, { id: 'c2' }] },
      tags: {},
      result: {
        history: {
          spot: {},
          dates: [
            {
              capture: 'c1',
              matches: [{ item: { kind: 'photo', layer: 'old', photo: 'o1' }, distanceM: 2 }],
              skipped: 0,
            },
          ],
        },
      },
      origin: 'c2',
    };
    panel();
    await click('ask-kind-change');
    expect(text('ask-dates-pick')).toBe('Pick the other date.');
    await click('ask-date-c1');
    expect(q('ask-dates-pick')).toBeNull();
  });

  it('Ask says it looks at the photo in view', async () => {
    panel();
    await click('ask-kind-ask');
    expect(text('ask-scope-ask')).toBe('Asks about the photo in view.');
  });

  it('a read-only package keeps Run and Save off', () => {
    h.readOnly = true;
    panel();
    setValue(area('ask-prompt'), 'find all gauges');
    expect(q('ask-run')?.disabled).toBe(true);
    expect(q('ask-usecase-save')?.disabled).toBe(true);
    expect(q('ask-readonly')).not.toBeNull();
  });

  it('Ask shows the thread in place of Run', async () => {
    panel();
    await click('ask-kind-ask');
    expect(q('ask-run')).toBeNull();
    expect(q('ask-prompt')).toBeNull();
    expect(q('thread-input')).not.toBeNull();
  });
});
