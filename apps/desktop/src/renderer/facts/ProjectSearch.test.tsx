// @vitest-environment jsdom
import type { Fact, FactHistory, FactIndexStatus } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factIndex } from './factStore';
import { ProjectSearch, SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, SEARCH_MAX_CHARS } from './ProjectSearch';

/** A fake bridge: each channel's answer, and every call made. */
type Answer = (req: Record<string, unknown>) => unknown;
const fake = vi.hoisted(() => {
  const answers: Partial<Record<string, Answer>> = {};
  return { calls: [] as { channel: string; request: Record<string, unknown> }[], answers };
});
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, request: Record<string, unknown>) => {
      fake.calls.push({ channel, request });
      const answer = fake.answers[channel];
      return Promise.resolve(
        answer ? { ok: true, value: answer(request) } : { ok: false, error: 'no answer' },
      );
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = (builtAt = '2026-11-11T10:00:00.000Z'): FactIndexStatus => ({
  state: 'ready',
  builtAt,
  counts: { issue: 2, measurement: 1 },
  links: 3,
});

const fact = (over: Partial<Fact> & Pick<Fact, 'id' | 'kind' | 'subject' | 'label'>): Fact => ({
  evidence: 'issues.json',
  ...over,
});

const pile = fact({
  id: 'measurement:m-1',
  kind: 'measurement',
  subject: 'measurement:m-1',
  label: 'North stockpile',
  date: '2026-07-01',
  value: 1234.5,
  unit: 'm3',
  status: 'accepted',
  evidence: 'survey/measurements.json',
});
const crack = fact({
  id: 'issue:I1',
  kind: 'issue',
  subject: 'issue:I1',
  label: 'Corrosion on the T-201 shell',
  date: '2026-07-01',
  status: 'reviewed',
});
const history: FactHistory = {
  subject: 'issue:I1',
  facts: [crack],
  linked: [
    {
      rel: 'on-survey',
      fact: fact({ id: 'survey:d1', kind: 'survey', subject: 'survey:d1', label: 'July' }),
    },
    {
      rel: 'inside',
      fact: { ...pile, date: '2026-07-01' },
    },
  ],
  events: [
    fact({
      id: 'event:1',
      kind: 'event',
      subject: 'issue:I1',
      label: 'Issue created',
      at: '2026-07-01T11:00:00.000Z',
    }),
    fact({
      id: 'event:2',
      kind: 'event',
      subject: 'issue:I1',
      label: 'Status set to reviewed',
      at: '2026-07-02T09:00:00.000Z',
    }),
  ],
  totals: { facts: 1, linked: 2, events: 2 },
};

let host: HTMLDivElement;
let root: Root | undefined;

function render(): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ProjectSearch />);
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

/** Type into the field and let the debounce and the answer land. */
async function type(text: string): Promise<void> {
  const input = q('project-search-field') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
  });
  await settle();
}
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.calls.length = 0;
  fake.answers = {
    'facts:query': (req) => {
      const text = (req.query as { text: string }).text.toLowerCase();
      const facts = [pile, crack].filter((f) => f.label.toLowerCase().includes(text));
      return { ok: true, facts, total: facts.length };
    },
    'facts:history': () => ({ ok: true, history }),
    'facts:rebuild': () => ({ ok: true, status: ready('2026-11-11T12:00:00.000Z') }),
  };
  workspace.setState({ project: { id: 'p1', root: 'C:/p1' } } as never);
  factIndex.setState({ projectId: 'p1', status: ready() });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

describe('ProjectSearch', () => {
  it('labels its field and says how much is indexed before a word is typed', () => {
    render();
    const input = q('project-search-field') as HTMLInputElement;
    const label = host.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe('Search this project');
    expect(q('project-search-count')?.textContent).toBe('3 records indexed');
    expect(fake.calls).toEqual([]);
  });

  it('asks main once the field settles and lists the results', async () => {
    render();
    await type('stock');
    const queries = fake.calls.filter((c) => c.channel === 'facts:query');
    expect(queries).toEqual([
      {
        channel: 'facts:query',
        request: { projectId: 'p1', query: { text: 'stock', limit: SEARCH_LIMIT } },
      },
    ]);
    const rows = all('project-search-result');
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? '';
    expect(text).toContain('Measure');
    expect(text).toContain('North stockpile');
    expect(text).toContain('m³');
    expect(text).toContain('Accepted');
    expect(q('project-search-count')?.textContent).toBe('1 result');
  });

  it('shows a status in the user language, and an unknown one as stored', async () => {
    fake.answers['facts:query'] = () => ({
      ok: true,
      facts: [crack, { ...pile, status: 'mystery' }],
      total: 2,
    });
    render();
    await type('a');
    const statuses = [...host.querySelectorAll('.fs-status')].map((e) => e.textContent);
    expect(statuses).toEqual(['Reviewed', 'mystery']);
  });

  it('caps the words at the length main accepts', async () => {
    render();
    const input = q('project-search-field') as HTMLInputElement;
    expect(input.maxLength).toBe(SEARCH_MAX_CHARS);
    // a pasted or scripted value can still be longer than the field allows
    await type('x'.repeat(SEARCH_MAX_CHARS + 50));
    const sent = fake.calls.find((c) => c.channel === 'facts:query')?.request as {
      query: { text: string };
    };
    expect(sent.query.text).toHaveLength(SEARCH_MAX_CHARS);
  });

  it('says why main cannot answer in its own words, not main text', async () => {
    fake.answers['facts:query'] = () => ({
      ok: false,
      error: 'Fact index not built (internal).',
      reason: 'not-built',
    });
    render();
    await type('stock');
    expect(host.textContent).toContain(
      'The search index is still being built. Try again in a moment.',
    );
    expect(host.textContent).not.toContain('internal');
    act(() => {
      root?.unmount();
    });
    host.remove();
    fake.answers['facts:query'] = () => ({ ok: false, error: 'pkg', reason: 'package' });
    render();
    await type('stock');
    expect(host.textContent).toContain('Packages have no search index.');
    act(() => {
      root?.unmount();
    });
    host.remove();
    fake.answers['facts:query'] = () => ({ ok: false, error: 'disk read failed' });
    render();
    await type('stock');
    expect(host.textContent).toContain('Search failed: disk read failed');
  });

  it('maps a history failure reason too', async () => {
    fake.answers['facts:history'] = () => ({ ok: false, error: 'closed', reason: 'not-open' });
    render();
    await type('corrosion');
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="project-search-result"] button')
        ?.click();
    });
    await settle();
    expect(q('project-search-history')?.textContent).toBe('Open a project to search it.');
  });

  it('says so when nothing matches', async () => {
    render();
    await type('flare');
    expect(all('project-search-result')).toHaveLength(0);
    expect(q('project-search-empty')?.textContent).toBe('Nothing matches "flare".');
  });

  it('opens and closes a result history inline, oldest first', async () => {
    render();
    await type('corrosion');
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="project-search-result"] button',
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      button?.click();
    });
    await settle();
    expect(fake.calls.filter((c) => c.channel === 'facts:history')).toEqual([
      { channel: 'facts:history', request: { projectId: 'p1', subject: 'issue:I1' } },
    ]);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const region = q('project-search-history');
    expect(region?.id).toBe(button?.getAttribute('aria-controls'));
    const linked = all('project-search-linked')[0]?.textContent ?? '';
    expect(linked).toContain('Survey date');
    expect(linked).toContain('July');
    expect(linked).toContain('Inside');
    expect(linked).toContain('North stockpile');
    const events = [...(q('project-search-events')?.querySelectorAll('li') ?? [])].map(
      (li) => li.querySelector('.fs-hlabel')?.textContent,
    );
    expect(events).toEqual(['Issue created', 'Status set to reviewed']);
    act(() => {
      button?.click();
    });
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(q('project-search-history')).toBeNull();
  });

  it('says the index is being built and does not search meanwhile', async () => {
    factIndex.setState({ status: { state: 'building', counts: {}, links: 0 } });
    render();
    expect(q('project-search-state')?.textContent).toBe('Indexing this project...');
    await type('stock');
    expect(fake.calls).toEqual([]);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="project-search-rebuild"]')?.disabled,
    ).toBe(true);
    // the index lands: the waiting words are asked at once
    act(() => {
      factIndex.setState({ status: ready() });
    });
    await settle();
    expect(q('project-search-state')).toBeNull();
    expect(all('project-search-result')).toHaveLength(1);
  });

  it('says when the project has no index or it failed', () => {
    factIndex.setState({ status: { state: 'error', counts: {}, links: 0, error: 'disk full' } });
    render();
    expect(q('project-search-state')?.textContent).toBe(
      'The search index could not be built: disk full',
    );
    act(() => {
      factIndex.setState({ status: { state: 'none', counts: {}, links: 0 } });
    });
    expect(q('project-search-state')?.textContent).toBe(
      'This project has no search index on this computer.',
    );
  });

  it('rebuilds the index and asks again with the same words', async () => {
    render();
    await type('stock');
    const button = q('project-search-rebuild') as HTMLButtonElement;
    expect(button.textContent).toBe('Rebuild index');
    act(() => {
      button.click();
    });
    expect(button.textContent).toBe('Rebuilding...');
    expect(button.disabled).toBe(true);
    await settle();
    expect(fake.calls.filter((c) => c.channel === 'facts:rebuild')).toEqual([
      { channel: 'facts:rebuild', request: { projectId: 'p1' } },
    ]);
    expect(factIndex.getState().status?.builtAt).toBe('2026-11-11T12:00:00.000Z');
    expect(fake.calls.filter((c) => c.channel === 'facts:query')).toHaveLength(2);
    expect(all('project-search-result').map((r) => r.textContent)).toHaveLength(1);
    expect(button.textContent).toBe('Rebuild index');
  });

  it('shows nothing without an open project', () => {
    workspace.setState({ project: null } as never);
    render();
    expect(q('project-search')).toBeNull();
  });
});
