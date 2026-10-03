import { setAnnotationAuthor } from '@aio/annotate';
import { useSyncExternalStore } from 'react';
import type { Bridge } from './bridge';

const KEY = 'stratlas.author';

let osUser = '';
let stored: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The name written into new issues: the Settings override, else the OS account name. */
export function authorName(): string {
  const own = stored?.trim() ?? '';
  return own.length > 0 ? own : osUser;
}

function apply() {
  setAnnotationAuthor(authorName());
  for (const l of listeners) l();
}

/** Set the issue author from Settings; an empty name falls back to the OS account. */
export function setAuthorName(name: string): void {
  stored = name;
  try {
    if (name.trim()) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the name lasts for this session */
  }
  apply();
}

/** Ask main for the OS account name once at startup. */
export async function initAuthor(bridge: Bridge): Promise<void> {
  const info = await bridge.call('app:getInfo', {});
  if (info.ok && info.value.user) osUser = info.value.user;
  apply();
}

export function useAuthor(): { name: string; override: string; osUser: string } {
  const name = useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, authorName);
  return { name, override: stored ?? '', osUser };
}
