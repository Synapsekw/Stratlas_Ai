import { LibraryClass } from '@aio/schema';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';

/** Classes saved on this computer for new projects (ANN-7), `userData/class-library.json`. */
export const CLASS_LIBRARY_SCHEMA = 'aio.classLibrary/1';

const LibraryFile = z.object({
  schema: z.string().optional(),
  classes: z.array(z.unknown()),
});

export interface ClassLibraryStore {
  list(): Promise<LibraryClass[]>;
  /** Add or replace (same label, any case); answers with the whole library. */
  save(cls: LibraryClass): Promise<LibraryClass[]>;
  remove(label: string): Promise<LibraryClass[]>;
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A class hotkey is one letter, not `a` or `u` (reserved in the sighting picker), not a digit. */
const validHotkey = (k: string) => /^[a-z]$/i.test(k) && !/^[au]$/i.test(k);

/** The class without a hotkey the picker cannot use (the class itself is still stored). */
function cleanHotkey(cls: LibraryClass): LibraryClass {
  if (cls.hotkey === undefined || validHotkey(cls.hotkey)) return cls;
  return {
    label: cls.label,
    color: cls.color,
    ...(cls.severityLevels ? { severityLevels: cls.severityLevels } : {}),
  };
}

export function createClassLibraryStore(file: string): ClassLibraryStore {
  /** The classes, and whether the file exists but cannot be read (then it is never overwritten). */
  async function load(): Promise<{ classes: LibraryClass[]; damaged: boolean }> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (e) {
      console.warn(`Class library ${file} is unreadable, ignoring it: ${String(e)}`);
      return { classes: [], damaged: true };
    }
    if (raw === undefined) return { classes: [], damaged: false };
    const f = LibraryFile.safeParse(raw);
    if (!f.success) {
      console.warn(`Class library ${file} is not a class library, ignoring it.`);
      return { classes: [], damaged: true };
    }
    const classes = f.data.classes.flatMap((c) => {
      const r = LibraryClass.safeParse(c);
      return r.success ? [r.data] : [];
    });
    return { classes, damaged: false };
  }

  async function write(classes: LibraryClass[]): Promise<LibraryClass[]> {
    const sorted = [...classes].sort((a, b) => a.label.localeCompare(b.label));
    await writeJsonAtomic(file, { schema: CLASS_LIBRARY_SCHEMA, classes: sorted });
    return sorted;
  }

  async function loadForWrite(): Promise<LibraryClass[]> {
    const cur = await load();
    if (cur.damaged) {
      throw new Error(`The class library file is damaged and was left as it is: ${file}`);
    }
    return cur.classes;
  }

  return {
    list: async () => (await load()).classes,
    async save(cls) {
      const parsed = cleanHotkey(LibraryClass.parse(cls));
      const cur = await loadForWrite();
      return write([...cur.filter((c) => !sameLabel(c.label, parsed.label)), parsed]);
    },
    async remove(label) {
      const cur = await loadForWrite();
      const next = cur.filter((c) => !sameLabel(c.label, label));
      return next.length === cur.length ? cur : write(next);
    },
  };
}
