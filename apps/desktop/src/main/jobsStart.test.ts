import type { IpcRequest } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { evidencePackRefusal } from './evidencePack';

/** Exercise the registered IPC callback without starting Electron or a pipeline process. */
function jobsStart(version: string, status: 'failed' | 'cancelled' | 'interrupted') {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.ArrowFunction | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'handle' &&
      node.arguments[0]?.getText(source) === "'jobs:start'"
    ) {
      const fn = node.arguments[1];
      if (fn && ts.isArrowFunction(fn)) callback = fn;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!callback) throw new Error('jobs:start handler is not registered.');
  const start = vi.fn(() => Promise.resolve({ ok: true }));
  const findPack = vi.fn(() => Promise.resolve({ pack: { version } }));
  const compiled = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const handle = runInNewContext(compiled, {
    jobs: { get: () => ({ id: 'saved-evidence', pipeline: 'model.evidence', status }), start },
    jobStore: { all: () => [] },
    drawingJobRefusal: () => Promise.resolve(null),
    photoBusyRefusal: () => null,
    odmGuard: { busy: () => null },
    settings: { current: () => ({ dataRoot: 'synthetic' }) },
    process: { env: {} },
    packApp: {},
    findPack,
    walkPackRefusal: () => null,
    panoPackRefusal: () => null,
    cleanPackRefusal: () => null,
    evidencePackRefusal,
    laneSphere: () => null,
  }) as (req: IpcRequest<'jobs:start'>) => Promise<{ ok: boolean; error?: string }>;
  return { handle, start, findPack };
}

describe('jobs:start resume feature gate', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'refuses resuming %s evidence jobs on the unrepaired pack',
    async (status) => {
      const t = jobsStart('0.13.0', status);
      expect(await t.handle({ resume: 'saved-evidence' })).toEqual({
        ok: false,
        error: evidencePackRefusal('model.evidence', '0.13.0'),
      });
      expect(t.start).not.toHaveBeenCalled();
    },
  );

  it.each(['0.13.1', 'dev'])(
    'allows the saved evidence pipeline to resume on pack %s',
    async (version) => {
      const t = jobsStart(version, 'failed');
      expect(await t.handle({ resume: 'saved-evidence' })).toEqual({ ok: true });
      expect(t.findPack).toHaveBeenCalledOnce();
      expect(t.start).toHaveBeenCalledWith({ resume: 'saved-evidence' });
    },
  );
});
