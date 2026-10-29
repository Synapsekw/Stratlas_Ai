/**
 * Which AI answers an Ask AI request. The person never picks it in the flow: the Settings default
 * (Auto, Local only, Cloud) and what is installed decide, so one button does the right thing. Auto
 * prefers what runs on this computer (the project's detectors, then the local model) over the
 * cloud; walk frames go to the local model only, local detectors read photos only. When nothing
 * can run, the answer says why. A cloud run also needs the person's yes first: `cloudConfirm` is
 * what that confirm shows (where it goes, how many, about what it costs, what is sent).
 */
import {
  detectInstructions,
  detectUserText,
  estimateDetect,
  PROVIDER_LABELS,
  type DetectEstimate,
} from '@aio/ai';
import type { DetectorModelInfo, Layer, ProjectManifest } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import { cloudItems, promptTaxonomy, type DetectItem } from '../../detections/convert';
import {
  MAX_RUN_DETECTORS,
  orderForProject,
  type Chosen,
} from '../../detections/detectors/runPlan';
import type { AskCheck, DetectorItem } from './checks';
import type { AskBackendPref } from './prefs';

export interface Availability {
  detectors: readonly DetectorItem[];
  local: { available: boolean; models: readonly DetectorModelInfo[]; problem?: string };
  cloud: { ready: boolean; message?: string; provider?: string; model?: string };
}

export type NoneReason = 'no-backend' | 'walk-local' | 'detector-photos' | 'nothing';

export type ResolvedBackend =
  | { kind: 'detectors'; chosen: Chosen[] }
  | { kind: 'local'; model: DetectorModelInfo }
  | { kind: 'cloud'; provider: string; model: string }
  | { kind: 'none'; reason: NoneReason; message?: string };

const REASON_KEYS = {
  'no-backend': 'askAi.reason.noBackend',
  'walk-local': 'askAi.reason.walkLocal',
  'detector-photos': 'askAi.reason.detectorPhotos',
  nothing: 'askAi.reason.nothing',
} as const satisfies Record<NoneReason, MessageKey>;

/** The sentence key that says why nothing can run. */
export function reasonKey(reason: NoneReason): (typeof REASON_KEYS)[NoneReason] {
  return REASON_KEYS[reason];
}

const none = (reason: NoneReason, message?: string): ResolvedBackend =>
  message ? { kind: 'none', reason, message } : { kind: 'none', reason };

export function resolveBackend(i: {
  pref: AskBackendPref;
  check: AskCheck;
  items: readonly DetectItem[];
  layers: readonly Layer[];
  avail: Availability;
  localModel: string | null;
  classMapOf: (modelId: string) => Record<string, string>;
  /** The project's asset types (its class catalogues'), for "everything" on detectors. */
  assetTypes?: readonly string[];
}): ResolvedBackend {
  const { pref, check, items, avail } = i;
  if (items.length === 0) return none('nothing');
  const allPhotos = items.every((x) => x.kind === 'photo');

  if (check.kind === 'detector') {
    const found =
      pref === 'cloud'
        ? undefined
        : avail.detectors.find((d) => d.where === check.where && d.detector.id === check.id);
    if (!found) return none('no-backend');
    if (!allPhotos) return none('detector-photos');
    return {
      kind: 'detectors',
      chosen: [
        { where: found.where, detector: found.detector, threshold: found.detector.threshold },
      ],
    };
  }

  const model =
    avail.local.available && avail.local.models.length > 0
      ? (avail.local.models.find((m) => m.id === i.localModel) ?? avail.local.models[0])
      : undefined;
  const walkIds = new Set(i.layers.filter((l) => l.kind === 'walk').map((l) => l.id));
  // the local model reads photos and walk frames; main refuses ordinary clip frames
  const localFits = items.every((x) => x.kind === 'photo' || walkIds.has(x.layer));
  if (items.some((x) => x.kind === 'frame' && walkIds.has(x.layer)))
    return model && localFits ? { kind: 'local', model } : none('walk-local');

  const cloud = avail.cloud;
  const cloudFits =
    cloud.ready &&
    !!cloud.provider &&
    !!cloud.model &&
    cloudItems(items, i.layers).length === items.length;
  const toCloud = (): ResolvedBackend => ({
    kind: 'cloud',
    provider: cloud.provider ?? '',
    model: cloud.model ?? '',
  });

  if (pref === 'cloud') return cloudFits ? toCloud() : none('no-backend', cloud.message);

  // on this computer first: the detectors (photos only), then the local model, then the cloud
  if (allPhotos) {
    const chosen =
      check.kind === 'class'
        ? avail.detectors.filter((d) => d.detector.classId === check.classId).slice(0, 1)
        : orderForProject(avail.detectors, i.assetTypes ?? []).forProject.slice(
            0,
            MAX_RUN_DETECTORS,
          );
    if (chosen.length > 0)
      return {
        kind: 'detectors',
        chosen: chosen.map((d) => ({
          where: d.where,
          detector: d.detector,
          threshold: d.detector.threshold,
        })),
      };
  }
  if (
    model &&
    localFits &&
    (check.kind === 'everything' ||
      Object.entries(i.classMapOf(model.id)).some(
        ([raw, to]) => model.card.classes.includes(raw) && to === check.classId,
      ))
  )
    return { kind: 'local', model };
  if (pref === 'auto' && cloudFits) return toCloud();
  return none(
    'no-backend',
    pref === 'local' ? avail.local.problem : (cloud.message ?? avail.local.problem),
  );
}

/** The word the cloud is asked to look for: the class's label for a class check, else none. */
export function cloudHint(check: AskCheck, classes: readonly { id: string; label: string }[]) {
  return check.kind === 'class' ? (classes.find((c) => c.id === check.classId)?.label ?? '') : '';
}

/** Images shown in the confirm's preview of what is sent. */
export const PREVIEW_IMAGES = 12;
/** Sizes assumed for the estimate when a photo has not been opened yet. */
const PHOTO_GUESS = { width: 2560, height: 1708 };
const FRAME_GUESS = { width: 1920, height: 1080 };

/** The size an item is assumed to have for an estimate, before it has been opened. */
export function guessSize(item: DetectItem): { width: number; height: number } {
  return item.kind === 'photo' ? PHOTO_GUESS : FRAME_GUESS;
}

export interface CloudConfirm {
  provider: string;
  /** The provider's name as people know it ("Anthropic"). */
  providerLabel: string;
  model: string;
  photos: number;
  frames: number;
  /** Tokens and cost before anything is sent; `costUsd` undefined when the model has no price. */
  estimate: DetectEstimate;
  /** The first images that are sent, for thumbnails. */
  preview: DetectItem[];
  hint: string;
  /** The instructions and the request text exactly as sent with each batch. */
  instructions: string;
  userText: string;
}

/** A cloud provider's name as people know it ("Anthropic"), else its id. */
export function providerLabelOf(provider: string): string {
  return provider in PROVIDER_LABELS
    ? PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS]
    : provider;
}

/** What the cloud confirm shows before a cloud run: nothing is sent until the person says yes. */
export function cloudConfirm(i: {
  backend: { provider: string; model: string };
  items: readonly DetectItem[];
  manifest: Pick<ProjectManifest, 'severityModels' | 'classCatalogues'>;
  check: AskCheck;
  batchSize: number;
}): CloudConfirm {
  const taxonomy = promptTaxonomy(i.manifest.severityModels, i.manifest.classCatalogues);
  const hint = cloudHint(i.check, taxonomy.classes);
  const prompt = { ...taxonomy, hint };
  const { provider, model } = i.backend;
  const photos = i.items.filter((x) => x.kind === 'photo').length;
  return {
    provider,
    providerLabel: providerLabelOf(provider),
    model,
    photos,
    frames: i.items.length - photos,
    estimate: estimateDetect({
      provider,
      model,
      images: i.items.map(guessSize),
      prompt,
      batchSize: i.batchSize,
    }),
    preview: i.items.slice(0, PREVIEW_IMAGES),
    hint,
    instructions: detectInstructions(prompt),
    userText: detectUserText(Math.min(i.items.length, Math.max(1, i.batchSize)), hint),
  };
}
