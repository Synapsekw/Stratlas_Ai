// Writer for the kill-during-append test (M9 integration, T1 in T8's kill harness): appends ops
// to a journal chain forever with the journal's own bench appender (`journalBench.append` in
// packages/journal/src/bench.ts: the chain writer seals and signs, the line goes to the kept-open
// segment and is synced, as the desktop journal service does). TEST-ONLY keys, made on the spot.
import { createJiti } from 'jiti';

const [dir] = process.argv.slice(2);
if (!dir) throw new Error('usage: kill-journal-writer.mjs <dir>');

const jiti = createJiti(import.meta.url);
const { journalBench } = await jiti.import('../../packages/journal/src/bench.ts');
const append = await journalBench.append(dir);
await append(0);
process.stdout.write('ready\n');
for (let i = 1; ; i++) await append(i);
