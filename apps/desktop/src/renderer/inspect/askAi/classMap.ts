/**
 * How a local model's class names map to the project's classes, remembered per project and model
 * on this computer under `stratlas.detect.classMap.<projectId>.<modelId>` (the keys the Detect
 * dialog wrote, so stored maps carry over). An empty value keeps the model's own name.
 */
import type { DetectorModelInfo } from '@aio/schema';

const PREFIX = 'stratlas.detect.classMap.';
const classMapKey = (projectId: string, modelId: string) => `${PREFIX}${projectId}.${modelId}`;

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a remembered mapping is a convenience only
  }
}

/** The project class a model class maps to by default: same id or label, else none. */
export function defaultClass(
  name: string,
  classes: readonly { id: string; label: string }[],
): string {
  const n = name.trim().toLowerCase();
  return (
    classes.find((c) => c.id.toLowerCase() === n || c.label.trim().toLowerCase() === n)?.id ?? ''
  );
}

/** The stored map of this project and model; empty when none is stored or it cannot be read. */
export function readClassMap(projectId: string, modelId: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readStore(classMapKey(projectId, modelId)) ?? '{}');
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

export function writeClassMap(
  projectId: string,
  modelId: string,
  map: Record<string, string>,
): void {
  writeStore(classMapKey(projectId, modelId), JSON.stringify(map));
}

/** The stored map with defaults for model classes not stored yet. */
export function classMapFor(
  projectId: string,
  model: DetectorModelInfo,
  classes: readonly { id: string; label: string }[],
): Record<string, string> {
  const stored = readClassMap(projectId, model.id);
  return Object.fromEntries(
    model.card.classes.map((c) => [c, stored[c] ?? defaultClass(c, classes)]),
  );
}

/**
 * A class was made from a model's word (Create class in the review): every local model of this
 * project that keeps that word as it is ("keep the name") now maps it to the new class. A word
 * mapped to a class on purpose is left alone.
 */
export function mapModelClass(projectId: string, raw: string, classId: string): void {
  const prefix = `${PREFIX}${projectId}.`;
  let keys: string[];
  try {
    keys = Object.keys(window.localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return;
  }
  const word = raw.trim().toLowerCase();
  for (const key of keys) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(readStore(key) ?? '{}') as Record<string, string>;
    } catch {
      continue;
    }
    const hit = Object.keys(map).find((k) => k.trim().toLowerCase() === word);
    if (hit === undefined || map[hit]) continue;
    writeStore(key, JSON.stringify({ ...map, [hit]: classId }));
  }
}
