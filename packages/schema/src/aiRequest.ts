import { z } from 'zod';
import { IsoTime } from './common';

/** Custom analytics: a saved use case (`aio.ai-request/1`) and the typed values it reads off a photo. */
export const AI_REQUEST_SCHEMA = 'aio.ai-request/1';
/** A request shared as one JSON file. */
export const AI_REQUEST_FILE_EXTENSION = '.aioreq';

export const FieldType = z.enum(['number', 'text', 'yesno', 'choice']);
export type FieldType = z.infer<typeof FieldType>;

export const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/** One value a request asks the model to read; `choices` is present exactly for `choice`. */
export const FieldSpec = z
  .object({
    key: FieldKey,
    label: z.string().min(1).max(60),
    type: FieldType,
    choices: z.array(z.string().min(1).max(40)).min(2).max(20).optional(),
    unit: z.string().max(20).optional(),
  })
  .strict()
  .refine((f) => (f.type === 'choice') === (f.choices !== undefined), {
    message: 'A choice field has choices; the other types have none.',
    path: ['choices'],
  });
export type FieldSpec = z.infer<typeof FieldSpec>;

/** A value read off a photo, stored on a detection or an issue. */
export const FieldValue = z
  .object({
    key: FieldKey,
    label: z.string().min(1).max(60),
    type: FieldType,
    value: z.union([z.number(), z.string(), z.null()]),
    unit: z.string().max(20).optional(),
    /** The request's choices, carried on a `choice` value so the form can limit the pick. */
    choices: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  })
  .strict()
  .refine(
    (f) => {
      if (f.value === null) return true;
      if (f.type === 'number') return typeof f.value === 'number' && Number.isFinite(f.value);
      if (typeof f.value !== 'string') return false;
      if (f.type === 'yesno') return f.value === 'yes' || f.value === 'no' || f.value === 'unknown';
      return f.value.length <= 200;
    },
    { message: 'The value does not match the field type.', path: ['value'] },
  );
export type FieldValue = z.infer<typeof FieldValue>;

export const AskKind = z.enum(['find', 'change', 'ask']);
export type AskKind = z.infer<typeof AskKind>;

export const AskScope = z.enum(['photo', 'selected', 'all', 'dates']);
export type AskScope = z.infer<typeof AskScope>;

export const AskCloudModel = z
  .object({ provider: z.enum(['anthropic', 'openai']), model: z.string().min(1).max(80) })
  .strict();
export type AskCloudModel = z.infer<typeof AskCloudModel>;

export const AskModelChoice = z.union([z.literal('auto'), z.literal('local'), AskCloudModel]);
export type AskModelChoice = z.infer<typeof AskModelChoice>;

export const AiRequestId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/);
export type AiRequestId = z.infer<typeof AiRequestId>;

export const AiRequest = z
  .object({
    schema: z.literal(AI_REQUEST_SCHEMA),
    id: AiRequestId,
    name: z.string().min(1).max(80),
    kind: AskKind,
    prompt: z.string().min(1).max(2000),
    fields: z.array(FieldSpec).max(12),
    scope: AskScope,
    model: AskModelChoice,
    defaults: z
      .object({
        classId: z.string().min(1).max(120).optional(),
        severity: z.union([z.number().int(), z.literal('uncertain')]).optional(),
      })
      .strict()
      .optional(),
    wholeImage: z.boolean().optional(),
    author: z.string().max(120),
    createdAt: IsoTime,
    updatedAt: IsoTime,
  })
  .strict()
  .refine((r) => new Set(r.fields.map((f) => f.key)).size === r.fields.length, {
    message: 'Field keys must be unique.',
    path: ['fields'],
  });
export type AiRequest = z.infer<typeof AiRequest>;

const Unit = z.number().min(0).max(1);

/** One answer item: a box normalised 0 to 1 of the last image, plus read values. */
export const AskItem = z
  .object({
    box: z.tuple([Unit, Unit, Unit, Unit]),
    label: z.string().max(80),
    note: z.string().max(500),
    fields: z.array(FieldValue).max(14),
  })
  .strict()
  .refine((i) => i.box[2] > i.box[0] && i.box[3] > i.box[1], {
    message: 'A box has x1 > x0 and y1 > y0.',
    path: ['box'],
  });
export type AskItem = z.infer<typeof AskItem>;

export const AskTurn = z
  .object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(8000) })
  .strict();
export type AskTurn = z.infer<typeof AskTurn>;
