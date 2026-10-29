/**
 * Follow-up threads in Ask AI: questions about one photo and the AI's answers, kept in memory for
 * the session. Another photo starts a new thread. The first cloud question needs the person's yes
 * (or the project's "Don't ask again"); its follow-ups resend the same image with the earlier
 * turns and no second confirm, while the route stays the one confirmed. "Make a finding" turns an
 * answer into a whole-image draft whose note is the answer, reviewed like any other draft.
 */
import { ASK_PROMPT_VERSION, ASK_SEND_MAX_PX, sendSize, type AskRoute } from '@aio/ai';
import { aiPassName, type Detection } from '@aio/annotate/detections';
import type { AskTurn, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { itemKey, itemSource, type DetectItem } from '../../detections/convert';
import { prepareItem } from '../../detections/prepare';
import type { PreparedImage } from '../../detections/runner';
import { dispatch } from '../../detections/store';
import { bridge } from '../../shell';
import { cloudConfirmSkipped } from './prefs';

export interface AskThread {
  /** The photo the thread is about (`itemKey`), null before the first question. */
  key: string | null;
  turns: { role: 'user' | 'assistant'; text: string }[];
  pending: boolean;
  error: string | null;
  route: AskRoute | null;
  /** The person said yes to sending this photo to `route`. */
  confirmed: boolean;
}

const EMPTY: AskThread = {
  key: null,
  turns: [],
  pending: false,
  error: null,
  route: null,
  confirmed: false,
};

export const askThread: StoreApi<AskThread> = createStore<AskThread>(() => ({ ...EMPTY }));

/** Earlier turns sent with a follow-up (the `ai:ask` cap). */
const MAX_TURNS = 20;

/** What the thread holds besides its store: the image as sent, and who answered. */
let ctx: {
  key: string;
  projectId: string;
  runId: string;
  image: PreparedImage | null;
  where: AskRoute['kind'] | null;
  provider: string;
  model: string;
  asks: number;
  drafted: boolean;
} | null = null;
/** Bumped on reset: an answer to an older thread is dropped. */
let gen = 0;

const sameRoute = (a: AskRoute | null, b: AskRoute) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === 'local' || (b.kind === 'cloud' && a.provider === b.provider && a.model === b.model));

function threadId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  return `${stamp}-ask-${globalThis.crypto.randomUUID().slice(0, 6)}`;
}

export function resetThread(): void {
  gen++;
  ctx = null;
  askThread.setState({ ...EMPTY, turns: [] });
}

export async function askInThread(o: {
  projectId: string;
  manifest: ProjectManifest;
  item: DetectItem & { kind: 'photo' };
  text: string;
  route: AskRoute;
  confirmed?: boolean;
}): Promise<void> {
  const text = o.text.trim();
  if (text === '') return;
  const key = itemKey(o.item);
  if (ctx?.key !== key || ctx.projectId !== o.projectId) resetThread();
  const s = askThread.getState();
  if (s.pending) return;
  const confirmed =
    o.route.kind === 'local' ||
    o.confirmed === true ||
    (s.confirmed && sameRoute(s.route, o.route)) ||
    cloudConfirmSkipped(o.projectId);
  if (!confirmed)
    throw new Error('A cloud question is sent only once the person has confirmed what is sent.');
  const c = (ctx ??= {
    key,
    projectId: o.projectId,
    runId: threadId(),
    image: null,
    where: null,
    provider: '',
    model: '',
    asks: 0,
    drafted: false,
  });
  const g = gen;
  // the earlier conversation in order, from the first question (the image rides with it); past
  // the cap the first pair stays and the oldest follow-up pairs drop out
  const earlier =
    s.turns.length <= MAX_TURNS
      ? s.turns
      : [...s.turns.slice(0, 2), ...s.turns.slice(-(MAX_TURNS - 2))];
  askThread.setState({
    key,
    turns: [...s.turns, { role: 'user', text }],
    pending: true,
    error: null,
    route: o.route,
    confirmed: true,
  });
  const fail = (error: string) => {
    if (g !== gen) return;
    // the question that did not finish leaves the thread as it was; the box keeps the text
    askThread.setState({
      turns: s.turns,
      pending: false,
      error: t('askAi.custom.failed', { error }),
    });
  };
  const maxPx = ASK_SEND_MAX_PX[o.route.kind];
  try {
    // the image is made once per thread and route kind: follow-ups resend the same image
    if (!c.image || c.where !== o.route.kind) {
      c.image = await prepareItem(o.projectId, o.manifest.layers, o.item, maxPx);
      c.where = o.route.kind;
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return;
  }
  if (g !== gen) return;
  const [width, height] = sendSize(c.image.width, c.image.height, maxPx);
  c.asks += 1;
  const res = await bridge.call('ai:ask', {
    runId: `${c.runId}-${String(c.asks)}`,
    projectId: o.projectId,
    backend: o.route,
    kind: 'ask',
    prompt: text.slice(0, 2000),
    fields: [],
    images: [{ key, dataUrl: c.image.dataUrl, width, height }],
    ...(earlier.length > 0 ? { turns: earlier.map((x): AskTurn => ({ ...x })) } : {}),
  });
  if (g !== gen) return;
  const answer = res.ok ? res.value : { ok: false as const, error: res.error };
  if (!answer.ok) {
    fail(answer.error);
    return;
  }
  const reply = (answer.text ?? '').trim();
  if (reply === '') {
    fail('The model gave no answer.');
    return;
  }
  c.provider = answer.provider;
  c.model = answer.model;
  askThread.setState((st) => ({
    turns: [...st.turns, { role: 'assistant', text: reply }],
    pending: false,
    error: null,
  }));
}

/**
 * Turn answer `turn` (an index into `turns`) into a whole-image draft on the photo: its note is
 * the answer, its label "AI answer", no class or severity until the reviewer sets them. Returns
 * the draft's id.
 */
export async function answerToDraft(o: {
  projectId: string;
  manifest: ProjectManifest;
  item: DetectItem & { kind: 'photo' };
  turn: number;
}): Promise<string> {
  const s = askThread.getState();
  const key = itemKey(o.item);
  const turn = s.turns[o.turn];
  if (s.key !== key || ctx?.key !== key || turn?.role !== 'assistant')
    throw new Error('There is no answer to make a finding from.');
  const c = ctx;
  const size = c.image ?? (await prepareItem(o.projectId, o.manifest.layers, o.item));
  const pass = aiPassName(c.runId);
  const now = new Date().toISOString();
  const id = globalThis.crypto.randomUUID();
  const d: Detection = {
    id,
    pass,
    source: itemSource(o.item),
    size: [size.width, size.height],
    geom: { type: 'box', x: 0, y: 0, w: size.width, h: size.height },
    classId: '',
    label: t('askAi.thread.answerLabel'),
    severity: null,
    uncertain: false,
    note: turn.text,
    status: 'draft',
    origin: {
      kind: 'ai',
      provider: c.provider,
      model: c.model,
      promptVersion: ASK_PROMPT_VERSION,
      runId: c.runId,
    },
    createdAt: now,
    updatedAt: now,
  };
  const first = !c.drafted;
  c.drafted = true;
  dispatch({
    type: 'add',
    detections: [d],
    label: t('askAi.thread.draft'),
    ...(first
      ? {
          run: {
            id: c.runId,
            pass,
            at: now,
            provider: c.provider,
            model: c.model,
            promptVersion: ASK_PROMPT_VERSION,
          },
        }
      : {}),
  });
  return id;
}
