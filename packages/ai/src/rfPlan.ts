/**
 * The AI step of Auto-plan (RF coverage): one request for the whole site, which proposes the
 * equipment from a fixed catalogue and one carrier for each detected unit. The geometry job
 * measured every number; the model never reports azimuth, tilt or height, and any such key in its
 * reply is dropped with a warning. The renderer validates each pick against the catalogue before
 * the review, so a pick here is only well formed, not yet usable.
 */
import type { RfPlanAiPick, RfPlanCatalogueInput, RfPlanUnitInput } from '@aio/schema';
import { extractJson, imageTokens } from './detect';

export type { RfPlanCatalogueInput, RfPlanUnitInput };

export const RF_PLAN_PROMPT_VERSION = 'rf-plan-v1';

/** One pick as the IPC reply carries it (Ruling R2): strict, with no geometry field. */
export type AiPickRaw = RfPlanAiPick;

/** The longest reason kept, as the IPC contract allows. */
const REASON_MAX = 200;
/** Longest model-chosen id echoed back in a warning. */
const WARNING_KEY_MAX = 80;
/** Most warnings one reply produces; the last says how many more there were. */
const WARNINGS_MAX = 20;
/** The crops are small: the geometry job writes them at about this size. */
const CROP_PX = 512;
const OUTPUT_PER_UNIT = 80;

/** Keys the model may not answer: the geometry belongs to the measurement, never to the AI. */
const GEOMETRY = /azimuth|bearing|tilt|height|elevation|altitude|position|^(lat|lon|lng|x|y|z)$/i;

/** The fixed instructions: what to choose, what never to report, JSON only. */
export function rfPlanInstructions(): string {
  return [
    'You help plan the radio coverage of a telecom tower. Each unit below is one detected antenna,',
    'with its measured size and anything a person typed about it.',
    'For each unit choose the equipment from the catalogue, by its id, and one carrier:',
    '- "entryId": the id of an AAU, or of an antenna; "radioId": the id of a radio that feeds that',
    '  antenna (leave it out for an AAU);',
    '- "band": a band the chosen equipment lists, for example "B3" or "n78";',
    '- "tech": "lte" or "nr". LTE and NR only;',
    '- "bandwidthMhz": the carrier bandwidth in MHz;',
    '- "reason": 20 words or fewer; "confidence": "high", "medium" or "low".',
    'A deep, wide unit is usually an AAU; a tall, narrow, thin one is usually a passive panel.',
    'Use only ids from the catalogue. Use "low" confidence when you are not sure.',
    'Do not report azimuth, tilt or height, or any other position: they are measured, not chosen.',
    'Answer with JSON only, no other text, in this form:',
    '{"picks":[{"unitId":"<id>","entryId":"<id>","radioId":"<id>","band":"<band>","tech":"lte","bandwidthMhz":20,"reason":"<reason>","confidence":"medium"}]}',
  ].join('\n');
}

const num = (v: number | undefined, unit: string) =>
  v === undefined || !Number.isFinite(v)
    ? undefined
    : `${String(Math.round(v * 100) / 100)} ${unit}`;

/** Text typed by a person goes in as a quoted value, on one line. */
const quoted = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/**
 * The text of the request: the units and the catalogue, by id only. It never holds the project,
 * site or operator name: only unit ids, sizes, what a person typed per unit and catalogue entries.
 */
export function rfPlanUserText(
  units: readonly RfPlanUnitInput[],
  catalogue: readonly RfPlanCatalogueInput[],
): string {
  const unitLines = units.map((u) => {
    const parts = [
      num(u.widthM, 'm wide'),
      num(u.heightM, 'm tall'),
      num(u.depthM, 'm deep'),
      num(u.downtiltDeg, 'deg downtilt'),
      num(u.heightAboveGroundM, 'm above ground'),
      u.userModel ? `model typed: ${quoted(u.userModel)}` : undefined,
      u.userFrequencies ? `frequencies typed: ${quoted(u.userFrequencies)}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return `- ${u.unitId}: ${parts.length ? parts.join(', ') : 'nothing measured'}`;
  });
  const entryLines = catalogue.map(
    (c) =>
      `- ${c.id} (${c.kind}): ${quoted(`${c.vendor} ${c.model}`)}, bands ${c.bands.join(', ') || 'none'}`,
  );
  return [
    `Units (${String(units.length)}):`,
    ...unitLines,
    '',
    `Catalogue (${String(catalogue.length)}):`,
    ...entryLines,
  ].join('\n');
}

const echo = (key: string) =>
  key.length > WARNING_KEY_MAX ? `${key.slice(0, WARNING_KEY_MAX)}...` : key;

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** The picks in a model reply, for the units that were sent; anything else is dropped with a warning. */
export function parseRfPlan(
  text: string,
  unitIds: readonly string[],
): { picks: AiPickRaw[]; warnings: string[] } {
  const warnings: string[] = [];
  const picks: AiPickRaw[] = [];
  const asked = new Set(unitIds);
  const json = extractJson(text);
  const list =
    typeof json === 'object' && json !== null && Array.isArray((json as { picks?: unknown }).picks)
      ? (json as { picks: unknown[] }).picks
      : null;
  if (!list) {
    return { picks, warnings: ['The reply was not a list of picks, so the AI planned no unit.'] };
  }
  const seen = new Set<string>();
  const bad = new Set<string>();
  for (const item of list) {
    const o = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const unitId = typeof o.unitId === 'string' ? o.unitId : '';
    if (!asked.has(unitId)) {
      warnings.push(`The reply planned "${echo(unitId)}", which was not sent. It was ignored.`);
      continue;
    }
    if (seen.has(unitId)) continue;
    const geometry = Object.keys(o).filter((k) => GEOMETRY.test(k));
    if (geometry.length > 0) {
      warnings.push(
        `The reply for ${unitId} gave ${geometry.map(echo).join(', ')}. The AI does not set geometry, so it was dropped.`,
      );
    }
    const entryId = str(o.entryId);
    const radioId = str(o.radioId);
    const band = str(o.band);
    const tech = o.tech === 'lte' || o.tech === 'nr' ? o.tech : undefined;
    const bw = o.bandwidthMhz;
    const bandwidthMhz = typeof bw === 'number' && Number.isFinite(bw) && bw > 0 ? bw : undefined;
    const confidence =
      o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
        ? o.confidence
        : undefined;
    if (!entryId || !band || !tech || bandwidthMhz === undefined || !confidence) {
      if (!bad.has(unitId)) {
        warnings.push(
          `The pick for ${unitId} is missing the equipment, band, LTE or NR, bandwidth or confidence. It was ignored.`,
        );
      }
      bad.add(unitId);
      continue;
    }
    // only the pick's own keys are kept; any other key is dropped (geometry with a warning)
    seen.add(unitId);
    const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, REASON_MAX) : '';
    picks.push({
      unitId,
      entryId,
      ...(radioId ? { radioId } : {}),
      band,
      tech,
      bandwidthMhz,
      reason,
      confidence,
    });
  }
  for (const id of unitIds) {
    if (!seen.has(id) && !bad.has(id)) warnings.push(`The reply has no pick for ${id}.`);
  }
  if (warnings.length > WARNINGS_MAX) {
    const more = warnings.length - (WARNINGS_MAX - 1);
    warnings.splice(
      WARNINGS_MAX - 1,
      warnings.length,
      `${String(more)} more warnings were not listed.`,
    );
  }
  return { picks, warnings };
}

const textTokens = (s: string) => Math.ceil(s.length / 4);

/** Rough input size of one request; the catalogue is counted at a typical size. */
export function estimateRfPlan(units: number, images: number): { inputTokens: number } {
  const u = Math.max(0, Math.floor(units));
  const n = Math.max(0, Math.floor(images));
  const perUnit = textTokens('- ant-0000000000: 0.45 m wide, 1.2 m tall, 0.2 m deep, 30 m above');
  const catalogue = 40 * textTokens('- generic-panel-65-17 (antenna): "Generic Panel", bands B3');
  const perImage = imageTokens('anthropic', CROP_PX, CROP_PX) + textTokens('Image of ant-0000');
  return {
    inputTokens: textTokens(rfPlanInstructions()) + catalogue + u * perUnit + n * perImage,
  };
}

/** Output tokens to expect for the estimate's cost. */
export const rfPlanOutputTokens = (units: number): number =>
  Math.max(0, Math.floor(units)) * OUTPUT_PER_UNIT;
