/**
 * The offline agent and the agent's project memory (intelligence review Wave 3, A3; agent.md
 * 4.8-4.11).
 *
 * - `BundledAgentCheck`: the tool-calling check of the Analytics pack's model (`ai:bundledAgentCheck`,
 *   kept in `Settings.bundledAgentCheck`). The bundled model runs the offline agent only while a
 *   check passed for the model installed now (its SHA-256).
 * - `AgentNote` / `AgentMemoryFile`: a few durable notes the agent may save and read for one
 *   project (`<project>/ai/memory.json`), visible and deletable by the person.
 */
import { z } from 'zod';
import { IsoTime, Sha256Hex } from './common';

// ---------------------------------------------------------------- the tool-calling check

export const ToolCheckOutcome = z.enum([
  'ok',
  'text-only',
  'wrong-tool',
  'invalid-call',
  'bad-args',
]);
export type ToolCheckOutcome = z.infer<typeof ToolCheckOutcome>;

/** The result of the tool-calling check of the bundled model, for the model it ran on. */
export const BundledAgentCheck = z
  .object({
    /** The model file's SHA-256 (the pack manifest's `model.sha256`): a new model checks again. */
    modelSha256: Sha256Hex,
    modelId: z.string().min(1).max(200),
    packVersion: z.string().min(1).max(40),
    passed: z.boolean(),
    correct: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    /** Correct cases needed to pass. */
    needed: z.number().int().positive(),
    invalidCalls: z.number().int().nonnegative(),
    meanLatencyMs: z.number().nonnegative(),
    /** Prompt tokens of one case: the compact profile's size on this model. */
    promptTokens: z.number().int().nonnegative().optional(),
    checkedAt: IsoTime,
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            ok: z.boolean(),
            outcome: ToolCheckOutcome,
            tool: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type BundledAgentCheck = z.infer<typeof BundledAgentCheck>;

/** What `ai:bundledAgent` answers: the installed pack's model, the stored check, and the verdict. */
export const BundledAgentStatus = z.object({
  /** The Analytics pack in use; null when none is installed. */
  pack: z
    .object({
      version: z.string(),
      modelId: z.string(),
      modelSha256: Sha256Hex,
      /** The context the server is started with, tokens. */
      contextTokens: z.number().int().positive(),
    })
    .nullable(),
  /** The last check, whatever model it ran on. */
  check: BundledAgentCheck.nullable(),
  /** Null: the bundled model may run the offline agent. Else why not, for the person. */
  blocked: z.string().nullable(),
});
export type BundledAgentStatus = z.infer<typeof BundledAgentStatus>;

// ---------------------------------------------------------------- project memory

/** Notes kept per project at most; the agent is told to forget one before saving more. */
export const AGENT_MEMORY_MAX_NOTES = 30;
/** Characters per note at most. */
export const AGENT_NOTE_MAX_CHARS = 300;

export const AgentNoteId = z.string().regex(/^n-[0-9a-z]{4,32}$/);
export type AgentNoteId = z.infer<typeof AgentNoteId>;

/** One durable note about the project ("the piles here are named SP-1 to SP-9"). */
export const AgentNote = z
  .object({
    id: AgentNoteId,
    text: z.string().trim().min(1).max(AGENT_NOTE_MAX_CHARS),
    /** A fact index subject the note is about (`measurement:m-3`), when it is about one thing. */
    about: z
      .string()
      .regex(/^[a-z-]+:\S{1,200}$/)
      .optional(),
    /** Saved by the agent (after the person approved it) or typed by the person. */
    by: z.enum(['agent', 'person']),
    createdAt: IsoTime,
  })
  .strict();
export type AgentNote = z.infer<typeof AgentNote>;

/** `<project>/ai/memory.json`. */
export const AgentMemoryFile = z
  .object({
    schema: z.literal('aio.agent-memory/1'),
    notes: z.array(AgentNote).max(AGENT_MEMORY_MAX_NOTES),
  })
  .strict();
export type AgentMemoryFile = z.infer<typeof AgentMemoryFile>;
