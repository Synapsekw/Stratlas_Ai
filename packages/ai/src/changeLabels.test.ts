import { CHANGE_LABEL_KINDS, ipc, type AskItem, type IpcResponse } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { askPrompt, parseAskReply } from './ask';
import {
  CHANGE_LABEL_FIELDS,
  CHANGE_LABEL_WORDS,
  changeLabelAsk,
  readChangeLabel,
} from './changeLabels';
import { askReply } from './scripted';

const img = (key: string, label: string) => ({
  key,
  dataUrl: 'data:image/jpeg;base64,x',
  width: 512,
  height: 512,
  label,
});

const ok = (items: AskItem[]): IpcResponse<'ai:ask'> => ({
  ok: true,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  promptVersion: 'ask-v1',
  items,
  inputTokens: 1,
  outputTokens: 1,
  warnings: [],
});

const item = (
  box: [number, number, number, number],
  kind: string | null,
  what: string | null = null,
  label = 'item',
  note = '',
): AskItem => ({
  box,
  label,
  note,
  fields: [
    { key: 'kind', label: 'Kind of change', type: 'choice', value: kind },
    { key: 'what', label: 'What', type: 'text', value: what },
  ],
});

describe('changeLabelAsk', () => {
  it('builds a valid change request with both crops, earlier first, on the whole image', () => {
    const req = changeLabelAsk({
      runId: 'r1',
      projectId: 'p',
      backend: { kind: 'local' },
      before: img('a', '1 Oct 2026'),
      after: img('b', '1 Nov 2026'),
      region: { areaM2: 123.4 },
    });
    expect(ipc['ai:ask'].request.safeParse(req).success).toBe(true);
    expect(req.kind).toBe('change');
    expect(req.wholeImage).toBe(true);
    expect(req.images.map((i) => i.key)).toEqual(['a', 'b']);
    expect(req.prompt).toMatch(/marked area/);
    expect(req.prompt).toMatch(/about 123 square metres/);
  });

  it('offers one human word per kind as the choice', () => {
    const kind = CHANGE_LABEL_FIELDS.find((f) => f.key === 'kind');
    expect(kind?.choices).toEqual(CHANGE_LABEL_KINDS.map((k) => CHANGE_LABEL_WORDS[k]));
    for (const c of kind?.choices ?? []) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('sends the kind choice in the prompt and reads it back from the scripted model', () => {
    const req = changeLabelAsk({
      runId: 'r',
      projectId: 'p',
      backend: { kind: 'cloud', provider: 'anthropic', model: 'm' },
      before: img('a', 'then'),
      after: img('b', 'now'),
    });
    const text = askPrompt({
      family: 'cloud',
      kind: req.kind,
      prompt: req.prompt,
      fields: req.fields,
      images: req.images.map((i) => ({ width: i.width, height: i.height })),
    });
    expect(text).toContain('"kind": "material added|material removed|');
    const parsed = parseAskReply(askReply(text), {
      family: 'cloud',
      kind: 'change',
      sent: { width: 512, height: 512 },
      fields: req.fields,
      wholeImage: true,
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(readChangeLabel(ok(parsed.items))?.kind).toBe('material-added');
  });
});

describe('readChangeLabel', () => {
  it('maps the choice word back to the kind and keeps what and the model', () => {
    expect(readChangeLabel(ok([item([0.3, 0.3, 0.7, 0.7], 'vehicle', 'a tipper truck')]))).toEqual({
      kind: 'vehicle',
      what: 'a tipper truck',
      model: 'claude-sonnet-5-5',
    });
  });

  it('picks the item that overlaps the marked area most', () => {
    const r = readChangeLabel(
      ok([item([0, 0, 0.1, 0.1], 'water'), item([0.35, 0.35, 0.65, 0.65], 'structure')]),
      [0.3, 0.3, 0.7, 0.7],
    );
    expect(r?.kind).toBe('structure');
    expect(
      readChangeLabel(
        ok([item([0, 0, 0.1, 0.1], 'water'), item([0.4, 0.4, 0.6, 0.6], 'structure')]),
      )?.kind,
    ).toBe('water');
  });

  it('reads the kind from the model words when the choice is empty, else other', () => {
    expect(readChangeLabel(ok([item([0, 0, 1, 1], null, 'excavator')]))?.kind).toBe('equipment');
    expect(
      readChangeLabel(ok([item([0, 0, 1, 1], null, null, 'thing', 'a new stockpile of gravel')]))
        ?.kind,
    ).toBe('material-added');
    expect(readChangeLabel(ok([item([0, 0, 1, 1], null, null, 'something')]))).toMatchObject({
      kind: 'other',
      what: 'something',
    });
  });

  it('says no-change when the model lists nothing, null when the ask failed', () => {
    expect(readChangeLabel(ok([]))).toEqual({ kind: 'no-change', model: 'claude-sonnet-5-5' });
    expect(readChangeLabel({ ok: false, error: 'no key', code: 'forbidden' })).toBeNull();
  });

  it('leaves out the placeholder label as what', () => {
    expect(readChangeLabel(ok([item([0, 0, 1, 1], 'other')]))).not.toHaveProperty('what');
  });
});
