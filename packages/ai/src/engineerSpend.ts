/**
 * What an engineering run has used of its AI allowance, kept in the project next to the run
 * (`engineering/<run>/ai/spend.json`) so a restart, a second window or a new runtime cannot reset
 * it: when its AI time started, what it spent, how many requests it made and their tokens. Main
 * process only. Written atomically (temporary file, then rename).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DETAIL_BUDGETS, type Detail } from '@aio/schema';
import { z } from 'zod';

export const SPEND_SCHEMA = 'aio.engineer-spend/1';

const RunSpendFile = z
  .object({
    schema: z.literal(SPEND_SCHEMA),
    /** Epoch ms of the run's first AI request: its 10 minutes of AI time count from here. */
    startedAt: z.number().int().nonnegative(),
    /** Known cost in US dollars. */
    spentUsd: z.number().nonnegative(),
    /** Model requests made (repairs included). */
    calls: z.number().int().nonnegative(),
    /** Input plus output tokens of those requests. */
    tokens: z.number().int().nonnegative(),
    /** Requests to a model without a price (sent after the person confirmed). */
    unpriced: z.number().int().nonnegative(),
  })
  .strict();
export type RunSpend = Omit<z.infer<typeof RunSpendFile>, 'schema'>;

/** Tokens a run may use per pass, whatever the price (also caps a model without a price). */
export const TOKENS_PER_PASS = 250_000;

/** A run's request and token limits: one request and one repair per pass. */
export function runLimits(detail: Detail): { calls: number; tokens: number } {
  const passes = DETAIL_BUDGETS[detail].passes;
  return { calls: passes * 2, tokens: passes * TOKENS_PER_PASS };
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
