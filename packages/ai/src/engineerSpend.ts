/**
 * What an engineering run has used of its AI allowance, kept in the project next to the run
 * (`engineering/<run>/ai/spend.json`) so a restart, a second window or a new runtime cannot reset
 * it: how long its requests were in flight, what it spent, how many requests it made and their
 * tokens. Main
 * process only. Written atomically (temporary file, then rename).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DETAIL_BUDGETS, type Detail } from '@aio/schema';
import { z } from 'zod';

export const SPEND_SCHEMA = 'aio.engineer-spend/1';

const RequestReservation = z
  .object({
    id: z.uuid(),
    costUsd: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type EngineerReservation = z.infer<typeof RequestReservation>;

const RunSpendFile = z
  .object({
    schema: z.literal(SPEND_SCHEMA),
    /** Epoch ms of the run's first reserved AI request (for the record). */
    startedAt: z.number().int().nonnegative(),
    /**
     * Milliseconds the run's AI requests were in flight, charged to its detail-level allowance. Not the time
     * between requests (the person reading a send preview). Absent in older files: 0.
     */
    aiMs: z.number().int().nonnegative().optional(),
    /** Time held before dispatch until elapsed time is saved; survives a crash or failed final write. */
    reservedAiMs: z.number().int().nonnegative().optional(),
    /** Known cost in US dollars. */
    spentUsd: z.number().nonnegative(),
    /** Model requests made (repairs included). */
    calls: z.number().int().nonnegative(),
    /** Input plus output tokens of those requests. */
    tokens: z.number().int().nonnegative(),
    /** Requests to a model without a price (sent after the person confirmed). */
    unpriced: z.number().int().nonnegative(),
    /** Unsettled requests. Estimates hold allowance; they are never reported as billed usage. */
    reservations: z.array(RequestReservation).optional(),
  })
  .strict();
export type RunSpend = Omit<z.infer<typeof RunSpendFile>, 'schema' | 'aiMs'> & { aiMs: number };

/** Known usage plus requests whose final usage is not yet known (including interrupted ones). */
export function committedRunSpend(spend: RunSpend) {
  return (spend.reservations ?? []).reduce(
    (total, r) => ({
      spentUsd: total.spentUsd + r.costUsd,
      calls: total.calls + 1,
      tokens: total.tokens + r.inputTokens + r.outputTokens,
    }),
    { spentUsd: spend.spentUsd, calls: spend.calls, tokens: spend.tokens },
  );
}

/** Tokens a run may use per pass, whatever the price (also caps a model without a price). */
export const TOKENS_PER_PASS = 250_000;

/** One answer and one repair per pass; a tool-enabled answer may take three bounded steps. */
export function runLimits(detail: Detail, withTools = false): { calls: number; tokens: number } {
  const passes = DETAIL_BUDGETS[detail].passes;
  return { calls: passes * 2 * (withTools ? 3 : 1), tokens: passes * TOKENS_PER_PASS };
}

const fileOf = (runDir: string) => join(runDir, 'ai', 'spend.json');

/**
 * The run's spend, `null` when it has none yet. Throws when the file is there but cannot be read
 * or is not valid: the caller refuses then rather than start again from nothing.
 */
export async function readRunSpend(runDir: string): Promise<RunSpend | null> {
  let text: string;
  try {
    text = await readFile(fileOf(runDir), 'utf8');
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  const f = RunSpendFile.parse(JSON.parse(text) as unknown);
  return {
    startedAt: f.startedAt,
    spentUsd: f.spentUsd,
    calls: f.calls,
    tokens: f.tokens,
    unpriced: f.unpriced,
    aiMs: f.aiMs ?? 0,
    ...(f.reservedAiMs !== undefined ? { reservedAiMs: f.reservedAiMs } : {}),
    ...(f.reservations ? { reservations: f.reservations } : {}),
  };
}

export async function writeRunSpend(runDir: string, spend: RunSpend): Promise<void> {
  const file = fileOf(runDir);
  await mkdir(join(runDir, 'ai'), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify({ schema: SPEND_SCHEMA, ...spend }), 'utf8');
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
