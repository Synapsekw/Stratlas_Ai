import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The names Settings, Processing tools lists (the `features` of `registerPipelinePackIpc`). */
function listedFeatures(): string[] {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(join(here, 'index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'registerPipelinePackIpc'
    ) {
      const arg = node.arguments[0];
      const features =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && p.name.getText(source) === 'features',
            )
          : undefined;
      const collect = (n: ts.Node): void => {
        if (ts.isArrayLiteralExpression(n))
          for (const e of n.elements) if (ts.isIdentifier(e)) names.push(e.text);
        ts.forEachChild(n, collect);
      };
      if (features) collect(features.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

/** Every `export const <NAME>_PACK_FEATURE` in the main process sources, with its file. */
function exportedFeatures(): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) walk(path);
      else if (d.name.endsWith('.ts') && !d.name.endsWith('.test.ts')) {
        for (const m of readFileSync(path, 'utf8').matchAll(
          /^export const ([A-Z0-9_]+_PACK_FEATURE)\b/gm,
        ))
          if (m[1]) out.push({ name: m[1], file: relative(here, path) });
      }
    }
  };
  walk(here);
  return out;
}

describe('Settings, Processing tools: what needs newer processing tools', () => {
  it('lists the antenna detection and antenna flagging features', () => {
    expect(listedFeatures()).toEqual(
      expect.arrayContaining(['ANTENNA_PACK_FEATURE', 'ANTENNA_FLAG_PACK_FEATURE']),
    );
  });

  it('lists every pack feature the main process exports', () => {
    const listed = new Set(listedFeatures());
    expect(exportedFeatures().filter((f) => !listed.has(f.name))).toEqual([]);
  });
});
