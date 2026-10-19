// Stop hook: warns when a plan or decision record changed but the north-star was not bumped.
// Reads the hook's stdin JSON (`stop_hook_active`, `cwd`).
//
//   node tools/agent/north-star-check.mjs   (Stop hook; stdin is the hook payload)
//
// It used to drop `docs/sessions/_draft-*.md` stubs too. Those only ever fired in the main checkout,
// where no work happens since every session builds in its own worktree, so they piled up unread and
// were removed. User-visible output is `{"systemMessage": ...}` JSON on stdout. Always exits 0; a
// broken hook must never break a session.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  NORTH_STAR,
  git,
  isEntryPoint,
  parsePorcelainZ,
  resolveRoot,
  toPosix,
} from './session-context.mjs';

// A change under any of these means a plan or decision moved, so the north-star should follow.
const BUMP_TRIGGERS = [/^docs\/plans\//, /^docs\/architecture\/adr\//];

export function needsNorthStarBumpWarning(changedPaths) {
  const paths = changedPaths.map(toPosix);
  const triggered = paths.some((p) => BUMP_TRIGGERS.some((re) => re.test(p)));
  return triggered && !paths.includes(NORTH_STAR);
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function run() {
  const payload = readPayload();
  if (payload?.stop_hook_active === true) return [];
  const root = resolveRoot(typeof payload?.cwd === 'string' ? payload.cwd : process.cwd());
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all'], root);
  if (status === null) return [];
  if (!needsNorthStarBumpWarning(parsePorcelainZ(status))) return [];
  return [
    '[north-star-check] A plan or decision record changed under docs/plans or ' +
      `docs/architecture/adr, but ${NORTH_STAR} was not bumped. Update it (or run /wrapup).`,
  ];
}

function main() {
  let messages;
  try {
    messages = run();
  } catch {
    messages = [];
  }
  if (messages.length > 0) {
    // writeFileSync(1) rather than console.log: stdout is a pipe under the hook runner.
    try {
      writeFileSync(1, JSON.stringify({ systemMessage: messages.join('\n') }) + '\n');
    } catch {
      // nothing more to do
    }
  }
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url)) main();
