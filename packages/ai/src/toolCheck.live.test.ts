/**
 * The tool-calling check against a real OpenAI-compatible server (the bundled llama-server, or
 * any local one). Skipped unless `QUADRION_TOOLCHECK_URL` is set; never runs in CI.
 *
 *   QUADRION_TOOLCHECK_URL=http://127.0.0.1:8080 QUADRION_TOOLCHECK_MODEL=qwen3.5-9b-q4_k_m \
 *   QUADRION_TOOLCHECK_KEY=<key, if the server wants one> QUADRION_TOOLCHECK_OUT=<result.json> \
 *   pnpm --filter @aio/ai exec vitest run src/toolCheck.live.test.ts
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localProvider } from './providers';
import { runToolCheck } from './toolCheck';

const url = process.env.QUADRION_TOOLCHECK_URL;

describe.skipIf(!url)('the tool-calling check on a real local server', () => {
  it('runs every case and reports the score', { timeout: 30 * 60_000 }, async () => {
    const model = localProvider({ baseUrl: url ?? '' }).languageModel(
      process.env.QUADRION_TOOLCHECK_MODEL ?? 'local',
      process.env.QUADRION_TOOLCHECK_KEY ?? null,
    );
    const runs = Number(process.env.QUADRION_TOOLCHECK_RUNS ?? '1');
    const all = [];
    for (let i = 0; i < runs; i++) {
      const r = await runToolCheck({
        model,
        onCase: (c, k, n) => {
          process.stdout.write(
            `[${String(i + 1)}] ${String(k + 1)}/${String(n)} ${c.id}: ${c.outcome}${c.tool ? ` (${c.tool})` : ''}${c.reason ? ` ${c.reason}` : ''} ${String(c.latencyMs)} ms\n`,
          );
        },
      });
      process.stdout.write(
        `run ${String(i + 1)}: ${String(r.correct)}/${String(r.total)} (needs ${String(r.needed)}), invalid ${String(r.invalidCalls)}, mean ${String(r.meanLatencyMs)} ms, prompt ${String(r.promptTokens)} tokens, ${r.passed ? 'PASS' : 'FAIL'}\n`,
      );
      all.push(r);
    }
    const out = process.env.QUADRION_TOOLCHECK_OUT;
    if (out) writeFileSync(out, JSON.stringify(all, null, 2));
    expect(all.length).toBe(runs);
  });
});
