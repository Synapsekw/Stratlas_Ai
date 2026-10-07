import { readSegment, type SegmentLine } from './segment';

/** A journal as files: project-relative path (forward slashes) to text. */
export type JournalFiles = ReadonlyMap<string, string>;

export interface LoadedSegment {
  /** Segment number from the file name (1 for `000001.jsonl`). */
  n: number;
  file: string;
  lines: SegmentLine[];
}

export interface LoadedChain {
  chain: string;
  /** Segments in number order (missing numbers are simply absent). */
  segments: LoadedSegment[];
}

export interface LoadedJournal {
  devices: Map<string, { file: string; raw: Record<string, unknown> | null }>;
  chains: Map<string, LoadedChain>;
  checkpoints: { file: string; raw: Record<string, unknown> | null }[];
}

const OPS_RE = /^journal\/ops\/([^/]+)\/(\d{6})\.jsonl$/;
const DEVICE_RE = /^journal\/devices\/([^/]+)\.json$/;
const CHECKPOINT_RE = /^journal\/checkpoints\/[^/]+\.json$/;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Sort the journal's files into devices, chains (segments in order) and checkpoints. */
export function loadJournal(files: JournalFiles): LoadedJournal {
  const devices = new Map<string, { file: string; raw: Record<string, unknown> | null }>();
  const chains = new Map<string, LoadedChain>();
  const checkpoints: { file: string; raw: Record<string, unknown> | null }[] = [];
  for (const [file, text] of files) {
    const ops = OPS_RE.exec(file);
    if (ops) {
      const chain = ops[1] ?? '';
      const c = chains.get(chain) ?? { chain, segments: [] };
      c.segments.push({ n: Number(ops[2]), file, lines: readSegment(text) });
      chains.set(chain, c);
      continue;
    }
    const dev = DEVICE_RE.exec(file);
    if (dev) {
      devices.set(dev[1] ?? '', { file, raw: parseObject(text) });
      continue;
    }
    if (CHECKPOINT_RE.test(file)) checkpoints.push({ file, raw: parseObject(text) });
  }
  for (const c of chains.values()) c.segments.sort((a, b) => a.n - b.n);
  checkpoints.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { devices, chains, checkpoints };
}
