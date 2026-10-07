// Writer for the kill-during-write test: writes two large, different JSON documents over `file`
// in turn with the app's own `writeJsonAtomic` (with a `.bak`), forever. Node strips the types
// of fsutil.ts itself (it imports only node: modules).
import { writeJsonAtomic } from '../../apps/desktop/src/main/fsutil.ts';

const [file, sizeArg] = process.argv.slice(2);
if (!file) throw new Error('usage: kill-writer.mjs <file> [items]');
const items = Number(sizeArg ?? 20_000);

/** Document `n`: recognisable as a whole, so a mix of two writes is caught. */
export const doc = (n) => ({
  schema: 'aio.issues/1',
  n,
  issues: Array.from({ length: items }, (_, i) => ({
    id: `i${String(i)}`,
    n,
    note: 'x'.repeat(40),
  })),
  end: n,
});

let n = 0;
await writeJsonAtomic(file, doc(n), { backup: true });
process.stdout.write('ready\n');
for (;;) {
  n = n === 0 ? 1 : 0;
  await writeJsonAtomic(file, doc(n), { backup: true });
}
