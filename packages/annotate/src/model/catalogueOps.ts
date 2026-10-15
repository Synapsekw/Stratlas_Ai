import {
  err,
  ok,
  type ClassCatalogue,
  type IssueClass,
  type Result,
  type SeverityModel,
} from '@aio/schema';
import { nextClassColour } from './palette';

/*
 * Editing a project's class catalogues (ANN-7). Pure: the app writes the result with
 * `builder:updateClasses`. Ids are slugs of the label, unique across all catalogues.
 */

/** Keys the sighting picker keeps for itself: `a` adds to the selected issue, `u` is uncertain. */
export const RESERVED_HOTKEYS: readonly string[] = ['a', 'u'];

/** The catalogue a project without any gets for its first class. */
export const DEFAULT_CATALOGUE = { id: 'classes', name: 'Classes', assetType: 'asset' } as const;

const MAX_LABEL = 80;

export interface NewClass {
  label: string;
  color?: string;
  hotkey?: string;
  severityModel?: string;
}

export interface ClassPatch {
  label?: string;
  color?: string;
  /** null or empty clears the hotkey. */
  hotkey?: string | null;
  severityModel?: string;
}

export function allClasses(catalogues: readonly ClassCatalogue[]): IssueClass[] {
  return catalogues.flatMap((c) => c.classes);
}

const cleanLabel = (label: string) => label.trim().replace(/\s+/g, ' ');
const sameLabel = (a: string, b: string) =>
  cleanLabel(a).toLowerCase() === cleanLabel(b).toLowerCase();

/** A lowercase id from a label: letters and digits, words joined by `-`; `class` when empty. */
export function classSlug(label: string): string {
  const s = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'class';
}

function uniqueClassId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

/** The severity model most classes use, else the project's first model; null without models. */
export function defaultSeverityModel(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
): string | null {
  const known = new Set(models.map((m) => m.id));
  const uses = new Map<string, number>();
  for (const c of allClasses(catalogues)) {
    if (known.has(c.severityModel)) uses.set(c.severityModel, (uses.get(c.severityModel) ?? 0) + 1);
  }
  const top = [...uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ?? models[0]?.id ?? null;
}

/** Why `hotkey` cannot be a class hotkey (ignoring class `exceptId`), or null. */
export function hotkeyProblem(
  catalogues: readonly ClassCatalogue[],
  hotkey: string,
  exceptId?: string,
): string | null {
  const k = hotkey.toLowerCase();
  if (!/^[a-z]$/.test(k)) return 'A hotkey is one letter.';
  if (RESERVED_HOTKEYS.includes(k)) {
    return `"${k}" is reserved in the class picker (a adds to the selected issue, u marks uncertain).`;
  }
  const other = allClasses(catalogues).find(
    (c) => c.id !== exceptId && c.hotkey?.toLowerCase() === k,
  );
  return other ? `"${k}" is the hotkey of ${other.label}.` : null;
}

function labelProblem(label: string): string | null {
  if (!label) return 'A class needs a name.';
  if (label.length > MAX_LABEL) return `A class name is at most ${String(MAX_LABEL)} characters.`;
  return null;
}

/**
 * A new class from a name (and, from the class library, a colour and hotkey). A label the project
 * has already (any case) returns that class with `created: false` and the catalogues unchanged.
 * A library hotkey that is taken or reserved is dropped, not refused.
 */
export function addClass(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  input: NewClass,
): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass; created: boolean }> {
  const label = cleanLabel(input.label);
  const bad = labelProblem(label);
  if (bad) return err(bad);
  const all = allClasses(catalogues);
  const same = all.find((c) => sameLabel(c.label, label));
  if (same) return ok({ catalogues: [...catalogues], cls: same, created: false });
  const severityModel = input.severityModel ?? defaultSeverityModel(catalogues, models);
  if (!severityModel) return err('The project has no severity model, so it cannot take a class.');
  if (!models.some((m) => m.id === severityModel)) {
    return err(`Severity model "${severityModel}" is not in the project.`);
  }
  const hotkey =
    input.hotkey && hotkeyProblem(catalogues, input.hotkey) === null
      ? input.hotkey.toLowerCase()
      : undefined;
  const cls: IssueClass = {
    id: uniqueClassId(classSlug(label), new Set(all.map((c) => c.id))),
    label,
    color: input.color ?? nextClassColour(all.map((c) => c.color)),
    severityModel,
    ...(hotkey ? { hotkey } : {}),
  };
  const target = catalogues.find((c) => c.assetType === 'road') ?? catalogues[0];
  if (!target) {
    return ok({ catalogues: [{ ...DEFAULT_CATALOGUE, classes: [cls] }], cls, created: true });
  }
  return ok({
    catalogues: catalogues.map((c) => (c === target ? { ...c, classes: [...c.classes, cls] } : c)),
    cls,
    created: true,
  });
}

/** Rename, recolour, set or clear the hotkey, change the severity model of one class. */
export function updateClass(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  id: string,
  patch: ClassPatch,
): Result<{ catalogues: ClassCatalogue[]; cls: IssueClass }> {
  const all = allClasses(catalogues);
  const cur = all.find((c) => c.id === id);
  if (!cur) return err(`Class "${id}" is not in the project.`);
  const next: IssueClass = { ...cur };
  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label);
    const bad = labelProblem(label);
    if (bad) return err(bad);
    const clash = all.find((c) => c.id !== id && sameLabel(c.label, label));
    if (clash) return err(`There is a class named ${clash.label} already.`);
    next.label = label;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) return err('Colour must be #rrggbb');
    next.color = patch.color;
  }
  if (patch.hotkey === null || patch.hotkey === '') {
    delete next.hotkey;
  } else if (patch.hotkey !== undefined) {
    const p = hotkeyProblem(catalogues, patch.hotkey, id);
    if (p) return err(p);
    next.hotkey = patch.hotkey.toLowerCase();
  }
  if (patch.severityModel !== undefined) {
    if (!models.some((m) => m.id === patch.severityModel)) {
      return err(`Severity model "${patch.severityModel}" is not in the project.`);
    }
    next.severityModel = patch.severityModel;
  }
  return ok({
    catalogues: catalogues.map((c) => ({
      ...c,
      classes: c.classes.map((k) => (k.id === id ? next : k)),
    })),
    cls: next,
  });
}

/** The catalogues without class `id` (its catalogue stays, even when empty). */
export function removeClass(
  catalogues: readonly ClassCatalogue[],
  id: string,
): Result<ClassCatalogue[]> {
  if (!allClasses(catalogues).some((c) => c.id === id)) {
    return err(`Class "${id}" is not in the project.`);
  }
  return ok(catalogues.map((c) => ({ ...c, classes: c.classes.filter((k) => k.id !== id) })));
}

/** How many issues and not-yet-accepted detections use class `id`. */
export function classUsage(
  issues: readonly { classId: string }[],
  detections: readonly { classId: string; status: string }[],
  id: string,
): { issues: number; detections: number } {
  return {
    issues: issues.filter((i) => i.classId === id).length,
    detections: detections.filter((d) => d.classId === id && d.status !== 'accepted').length,
  };
}
