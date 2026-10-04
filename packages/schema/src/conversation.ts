import { z } from 'zod';
import { ToolRisk, WindowKind } from './agent';
import { IsoTime } from './common';

export const CONVERSATION_SCHEMA = 'aio.conversation/1' as const;

/** A conversation id is also its file name in `<project>/ai/conversations/`, so no separators. */
export const ConversationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Conversation ids are letters, digits, _ and -');

export const StepStatus = z.enum([
  'running',
  'awaiting',
  'done',
  'rejected',
  'error',
  'undone',
  'cancelled',
]);

/** One tool call in a conversation. `awaiting` survives a restart and is never run without a click. */
export const ConversationStep = z.object({
  callId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  input: z.unknown(),
  risk: ToolRisk,
  status: StepStatus,
  summary: z.string().max(500).optional(),
  canUndo: z.boolean(),
});

export const ConversationPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('step'), callId: z.string().min(1).max(128) }),
]);

export const ConversationTurn = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string().min(1).max(128),
    text: z.string(),
    chips: z.array(z.string()),
    frame: z.boolean(),
  }),
  z.object({
    kind: z.literal('assistant'),
    id: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    parts: z.array(ConversationPart),
    status: z.enum(['streaming', 'done', 'error', 'stopped']),
    error: z.string().optional(),
  }),
]);

export const ConversationUsage = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  costKnown: z.boolean(),
});

/**
 * A saved agent conversation, `<project>/ai/conversations/<id>.json`. Text only: attached frames
 * are recorded as a flag, never stored.
 */
export const Conversation = z.object({
  schema: z.literal(CONVERSATION_SCHEMA),
  id: ConversationId,
  title: z.string().max(200),
  window: WindowKind,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  turns: z.array(ConversationTurn).max(5000),
  steps: z.record(z.string(), ConversationStep),
  usage: ConversationUsage,
});

export const ConversationSummary = z.object({
  id: ConversationId,
  title: z.string(),
  window: WindowKind,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  turns: z.number().int().nonnegative(),
  /** Write or send steps still waiting for approval. */
  pending: z.number().int().nonnegative(),
});

export type ConversationStep = z.infer<typeof ConversationStep>;
export type ConversationTurn = z.infer<typeof ConversationTurn>;
export type ConversationUsage = z.infer<typeof ConversationUsage>;
export type Conversation = z.infer<typeof Conversation>;
export type ConversationSummary = z.infer<typeof ConversationSummary>;
export type StepStatus = z.infer<typeof StepStatus>;
