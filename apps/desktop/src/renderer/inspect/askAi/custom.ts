/**
 * Custom requests in Inspect's Ask AI: what a request's answer items become (draft detections on
 * the photo, in its original pixels, with the request's default class and severity), what the
 * cloud confirm shows before a custom cloud run, and what an ask can use right now. Severity is
 * never asked of the model: a draft carries the request's default, else none.
 */
import {
  ASK_PROMPT_VERSION,
  ASK_SEND_MAX_PX,
  CHANGE_FIELDS,
  askPrompt,
  estimateAsk,
  sendSize,
  type AskRoute,
} from '@aio/ai';
import { normBoxToPixels, type Detection } from '@aio/annotate/detections';
import type { AiRequest, AskItem, FieldSpec, IpcResponse } from '@aio/schema';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { itemSource, type DetectItem } from '../../detections/convert';
import { useCall, useShell } from '../../shell';
import { guessSize, PREVIEW_IMAGES, providerLabelOf, type CloudConfirm } from './backend';

/** A request as a run needs it: saved (with its id) or typed in for this run. */
export type AskDraftRequest = Pick<
  AiRequest,
  'kind' | 'prompt' | 'fields' | 'defaults' | 'wholeImage'
> & { id?: string; name: string };

/** The name a run shows for a request ("Custom request" when it has none). */
export function requestName(r: Pick<AskDraftRequest, 'name'>): string {
  const name = r.name.trim();
  return t('askAi.custom.what', { name: name === '' ? t('askAi.custom.untitled') : name });
}

/** The fields sent with a request: a change reads its two built-in values first. */
export function sendFields(r: Pick<AskDraftRequest, 'kind' | 'fields'>): FieldSpec[] {
  if (r.kind !== 'change') return [...r.fields];
  const own = new Set(CHANGE_FIELDS.map((f) => f.key));
  return [...CHANGE_FIELDS, ...r.fields.filter((f) => !own.has(f.key))];
}

/** Answer items as draft detections on `item` (boxes in the original's pixels). */
export function askItemsToDrafts(o: {
  items: readonly AskItem[];
  item: DetectItem;
  size: { width: number; height: number };
  request: AskDraftRequest;
  classes: readonly { id: string; label: string }[];
  runId: string;
  pass: string;
  provider: string;
  model: string;
  now: string;
  newId: () => string;
}): Detection[] {
  const source = itemSource(o.item);
  const byDefault = o.request.defaults?.classId;
  const known = byDefault !== undefined && o.classes.some((c) => c.id === byDefault);
  const severity = o.request.defaults?.severity ?? null;
  const out: Detection[] = [];
  for (const a of o.items) {
    // an answer box is corners (x0, y0, x1, y1); a detection box is corner and size
    const [x0, y0, x1, y1] = a.box;
    const geom = normBoxToPixels([x0, y0, x1 - x0, y1 - y0], o.size);
    if (!geom) continue;
    const word = a.label.trim().toLowerCase();
    const classId = known
      ? byDefault
      : (o.classes.find((c) => word !== '' && c.label.trim().toLowerCase() === word)?.id ?? '');
    const d: Detection = {
      id: o.newId(),
      pass: o.pass,
      source,
      size: [o.size.width, o.size.height],
      geom,
      classId,
      label: a.label,
      severity,
      uncertain: severity === 'uncertain',
      note: a.note,
      status: 'draft',
      origin: {
        kind: 'ai',
        provider: o.provider,
        model: o.model,
        promptVersion: ASK_PROMPT_VERSION,
        runId: o.runId,
        ...(o.request.id !== undefined ? { request: o.request.id } : {}),
      },
      createdAt: o.now,
      updatedAt: o.now,
    };
    if (a.fields.length > 0) d.fields = a.fields.map((f) => ({ ...f }));
    out.push(d);
  }
  return out;
}

/**
 * What the cloud confirm shows before a custom cloud run: where it goes, how many images, about
 * what it costs, and the prompt exactly as sent for the first image (a custom request has no
 * separate instructions). `items` are every image the run sends; `requests` how many asks.
 */
export function askConfirmInfo(o: {
  route: Extract<AskRoute, { kind: 'cloud' }>;
  items: readonly DetectItem[];
  request: AskDraftRequest;
  requests: number;
}): CloudConfirm {
  const { provider, model } = o.route;
  const sent = o.items.map((x) => {
    const g = guessSize(x);
    const [width, height] = sendSize(g.width, g.height, ASK_SEND_MAX_PX.cloud);
    return { width, height };
  });
  const fields = sendFields(o.request);
  const first = o.request.kind === 'change' ? sent.slice(0, 2) : sent.slice(0, 1);
  const photos = o.items.filter((x) => x.kind === 'photo').length;
  return {
    provider,
    providerLabel: providerLabelOf(provider),
    model,
    photos,
    frames: o.items.length - photos,
    estimate: estimateAsk({
      provider,
      model,
      kind: o.request.kind,
      images: sent,
      prompt: o.request.prompt,
      fields,
      requests: o.requests,
    }),
    preview: o.items.slice(0, PREVIEW_IMAGES),
    hint: '',
    instructions: '',
    userText: askPrompt({
      family: 'cloud',
      kind: o.request.kind,
      prompt: o.request.prompt,
      fields,
      images: first,
    }),
  };
}

/**
 * What an ask can use right now (the cloud and why not, the keep-local switch, this PC's model),
 * read again when the AI settings or the project's manifest change, as Ask AI's own status is.
 */
export function useAskStatus(projectId: string): IpcResponse<'ai:askStatus'> | null {
  const aiKey = useShell((s) =>
    JSON.stringify([
      s.settings.cloudAi,
      s.settings.offlineOnly === true,
      s.settings.routes,
      s.settings.localModel,
      s.settings.inference?.provider,
    ]),
  );
  const manifest = useWorkspace((s) => s.project?.manifest);
  const key = useMemo(() => ({ projectId, aiKey, manifest }), [projectId, aiKey, manifest]);
  const res = useCall('ai:askStatus', { projectId }, key);
  return res?.ok ? res.value : null;
}
