// Editing the report narrative (BLD-7): texts in the editor, saved as versions of
// `report/narrative.json`. Pure, so the rules are tested without the UI.
import {
  addNarrativeVersion,
  currentNarrative,
  NARRATIVE_SECTIONS,
  type NarrativeFile,
  type NarrativeSectionId,
  type NarrativeVersion,
} from '@aio/schema';

export type Drafts = Record<NarrativeSectionId, string>;

/** What the editor shows: the newest saved text of each part, else `fallback`. */
export function editorTexts(file: NarrativeFile | null, fallback: Drafts): Drafts {
  const out = { ...fallback };
  for (const id of NARRATIVE_SECTIONS) {
    const saved = currentNarrative(file, id);
    if (saved !== null) out[id] = saved;
  }
  return out;
}

/** Parts whose editor text differs from the saved text (or from nothing saved). */
export function changedParts(file: NarrativeFile | null, drafts: Drafts): NarrativeSectionId[] {
  return NARRATIVE_SECTIONS.filter((id) => currentNarrative(file, id) !== drafts[id]);
}

/**
 * Save texts as new versions. `source` per part says where the text came from; a text the
 * person typed is `user`. Parts with the newest saved text unchanged keep their history as is.
 */
export function saveParts(
  file: NarrativeFile | null,
  texts: Partial<Drafts>,
  meta: Omit<NarrativeVersion, 'text' | 'createdAt'> & { createdAt?: string },
  now: Date = new Date(),
): NarrativeFile | null {
  let next = file;
  for (const id of NARRATIVE_SECTIONS) {
    const text = texts[id];
    if (text === undefined || currentNarrative(next, id) === text) continue;
    next = addNarrativeVersion(next, id, {
      ...meta,
      text,
      createdAt: meta.createdAt ?? now.toISOString(),
    });
  }
  return next;
}

/** Restore an older version: saved again as the newest, so nothing is lost. */
export function restoreVersion(
  file: NarrativeFile,
  id: NarrativeSectionId,
  index: number,
  now: Date = new Date(),
): NarrativeFile {
  const v = file.parts[id]?.versions[index];
  if (!v) return file;
  const last = file.parts[id]?.versions.at(-1);
  if (last === v) return file;
  const restored: NarrativeVersion = { ...v, createdAt: now.toISOString() };
  const versions = [...(file.parts[id]?.versions ?? []), restored];
  return { ...file, parts: { ...file.parts, [id]: { versions } } };
}

/** Versions of a part, newest first, with their index in the file. */
export function versionsOf(
  file: NarrativeFile | null,
  id: NarrativeSectionId,
): { index: number; version: NarrativeVersion }[] {
  const list = file?.parts[id]?.versions ?? [];
  return list.map((version, index) => ({ index, version })).reverse();
}

/** Does a text still hold [bracketed] prompts from the template? */
export const hasPlaceholders = (text: string): boolean => /\[[^\]\n]{3,300}\]/.test(text);
