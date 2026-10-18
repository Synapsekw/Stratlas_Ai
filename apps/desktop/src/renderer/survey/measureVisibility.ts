/**
 * Which measurements a person has hidden, remembered per project in this renderer's
 * localStorage. Personal view state: it is never written to `measurements.json`.
 */
export const HIDDEN_KEY = 'quadrion.measure.hidden';

export interface MeasureVisibilityMemory {
  load(projectId: string): string[];
  save(projectId: string, ids: readonly string[]): void;
}

/** The renderer's localStorage, or null where it is blocked. */
export function measureStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Storage-backed memory; a session map keeps the ids when storage is blocked or missing. */
export function createMeasureVisibilityMemory(storage: Storage | null): MeasureVisibilityMemory {
  const session = new Map<string, string[]>();
  const key = (projectId: string) => `${HIDDEN_KEY}:${projectId}`;
  return {
    load(projectId) {
      try {
        const raw = storage?.getItem(key(projectId)) ?? null;
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          return Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === 'string')
            : [];
        }
      } catch {
        // blocked or malformed: fall through to this session's ids
      }
      return [...(session.get(projectId) ?? [])];
    },
    save(projectId, ids) {
      session.set(projectId, [...ids]);
      try {
        storage?.setItem(key(projectId), JSON.stringify(ids));
      } catch {
        // blocked: the session map holds them
      }
    },
  };
}
