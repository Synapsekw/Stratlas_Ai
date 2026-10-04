import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';

export type Level = 'info' | 'warn' | 'error';

const MAX_BYTES = 2 * 1024 * 1024;

function format(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return (arg.stack ?? String(arg)).split('\n').slice(0, 4).join(' | ');
  try {
    // undefined, functions and symbols have no JSON form.
    if (arg === undefined || typeof arg === 'function' || typeof arg === 'symbol')
      return String(arg);
    return JSON.stringify(arg);
  } catch {
    return inspect(arg, { depth: 2, breakLength: Infinity });
  }
}

/**
 * The main-process log: `<dir>/main.log`, moved to `main.1.log` when it passes `maxBytes`.
 * Writes are queued so lines stay in order; logging never throws.
 */
export function createLog(
  dir: string,
  { maxBytes = MAX_BYTES, now = () => new Date() }: { maxBytes?: number; now?: () => Date } = {},
) {
  const file = join(dir, 'main.log');
  let queue: Promise<void> = mkdir(dir, { recursive: true }).then(
    () => undefined,
    () => undefined,
  );

  async function append(line: string): Promise<void> {
    try {
      const size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        await rename(file, join(dir, 'main.1.log'));
      }
      await appendFile(file, line, 'utf8');
    } catch {
      // A full or read-only disk must not take the app down.
    }
  }

  return {
    dir,
    write(level: Level, args: unknown[]): void {
      const line = `${now().toISOString()} ${level.toUpperCase()} ${args.map(format).join(' ')}\n`;
      queue = queue.then(() => append(line));
    },
    flush(): Promise<void> {
      return queue;
    },
  };
}

export type AppLog = ReturnType<typeof createLog>;

/** Mirror console.info/log/warn/error into the log file (the console keeps working). */
export function captureConsole(log: AppLog): void {
  const wrap = (name: 'log' | 'info' | 'warn' | 'error', level: Level) => {
    // eslint-disable-next-line no-console -- wrapping the console is the point
    const original = console[name].bind(console);
    // eslint-disable-next-line no-console -- wrapping the console is the point
    console[name] = (...args: unknown[]) => {
      original(...args);
      log.write(level, args);
    };
  };
  wrap('log', 'info');
  wrap('info', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

/** Write `details` and every `*.log` in `dir` (oldest first) into one text file. */
export async function exportLogs(dir: string, target: string, details: string[]): Promise<void> {
  const names = await readdir(dir).then(
    (all) => all.filter((n) => n.endsWith('.log')),
    () => [] as string[],
  );
  // main.1.log is older than main.log.
  const generation = (n: string) => /\.(\d+)\.log$/.exec(n)?.[1] ?? '0';
  names.sort((a, b) => generation(b).localeCompare(generation(a)));
  const parts = [...details, ''];
  if (names.length === 0) parts.push('No log files were written yet.');
  for (const name of names) {
    parts.push(`===== ${name} =====`, await readFile(join(dir, name), 'utf8'));
  }
  const tmp = `${target}.tmp`;
  await writeFile(tmp, parts.join('\n'), 'utf8');
  try {
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
