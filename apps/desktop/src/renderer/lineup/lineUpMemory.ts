/**
 * What the background line-up check remembers on this workstation, per project: the pairs of
 * layers it has measured, and the pairs answered "Not now". Kept in renderer storage (500 entries
 * each, as the street map offer); blocked storage keeps the answers for this session.
 */

const MEASURED_KEY = 'quadrion.lineUp.measured';
const NOT_NOW_KEY = 'quadrion.lineUp.notNow';
const LIMIT = 500;

export interface LineUpMemory {
  /** The pair keys measured in this project. */
  measured(projectId: string): Set<string>;
  markMeasured(projectId: string, key: string): void;
  isNotNow(projectId: string, key: string): boolean;
  notNow(projectId: string, key: string): void;
}

const entry = (projectId: string, key: string) => `${projectId}\n${key}`;

export function createLineUpMemory(storage: Storage | null): LineUpMemory {
  const session = new Map<string, Set<string>>([
    [MEASURED_KEY, new Set()],
    [NOT_NOW_KEY, new Set()],
  ]);
  const read = (name: string): string[] => {
    const own = [...(session.get(name) ?? [])];
    try {
      const v = JSON.parse(storage?.getItem(name) ?? '[]') as unknown;
      const stored = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      return [...new Set([...stored, ...own])];
    } catch {
      return own;
    }
  };
  const add = (name: string, value: string) => {
    session.get(name)?.add(value);
    const all = read(name).filter((x) => x !== value);
    try {
      storage?.setItem(name, JSON.stringify([...all, value].slice(-LIMIT)));
    } catch {
      // blocked storage: the answer lasts for this session
    }
  };
  return {
    measured: (projectId) => {
      const prefix = `${projectId}\n`;
      return new Set(
        read(MEASURED_KEY)
          .filter((x) => x.startsWith(prefix))
          .map((x) => x.slice(prefix.length)),
      );
    },
    markMeasured: (projectId, key) => {
      add(MEASURED_KEY, entry(projectId, key));
    },
    isNotNow: (projectId, key) => read(NOT_NOW_KEY).includes(entry(projectId, key)),
    notNow: (projectId, key) => {
      add(NOT_NOW_KEY, entry(projectId, key));
    },
  };
}
