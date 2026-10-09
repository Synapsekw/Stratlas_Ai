import {
  ComparisonItem,
  SurveyTemplate,
  type ComparisonPreset,
  type CustomField,
  type MeasurementScope,
  type MeasurementStyle,
  type MeasurementTool,
  type SitePoint,
  type SurveyMeasurement,
  type SurveyTemplatesFile,
} from '@aio/schema';
import { DEFAULT_ITEMS, ITEM_LABELS, TOOL_FAMILY, TOOL_LABELS } from '../tools/readout';
import { resolvePreset, type RolePicks } from './designRoles';

/**
 * Measurement templates (data-conventions section 27): the model and the editor's logic. A
 * template picks a tool, the result rows in order, custom fields (text, number, dropdown),
 * default comparison presets, a default style and a description; a bookmark puts it on the
 * toolbar. A measurement made from a template can switch template later. Templates live in the
 * project (`survey/templates.json`) and in the person's library (userData); the industry sets
 * (G9) ship as JSON next to this file.
 */

const SLUG = /[^A-Za-z0-9._-]+/g;

/** A file-name-safe id from a name, unique among `taken`. */
export function uniqueId(name: string, taken: Iterable<string>, fallback = 'item'): string {
  const used = new Set(taken);
  const base =
    name
      .normalize('NFKD')
      .replace(SLUG, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .toLowerCase()
      .slice(0, 60) || fallback;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

/** Items a tool can show, in the order the editor offers them. */
export function availableItems(tool: MeasurementTool): string[] {
  const own = DEFAULT_ITEMS[tool];
  const family = TOOL_FAMILY[tool];
  const extra: Record<string, string[]> = {
    point: ['e', 'n', 'z', 'surface-z', 'dz'],
    line: [
      'horizontal',
      'slope-length',
      'terrain-length',
      'height-change',
      'grade',
      'max-grade',
      'bearing',
      'vertical-angle',
      'vertices',
    ],
    polygon: ['area', 'terrain-area', 'slope-area', 'perimeter', 'cut', 'fill', 'net', 'total'],
    markup: ['vertices', 'horizontal'],
  };
  return [...new Set([...own, ...(extra[family] ?? [])])].filter((k) => k in ITEM_LABELS);
}

/** A new template for a tool, with that tool's default rows. */
export function newTemplate(
  name: string,
  tool: MeasurementTool,
  taken: Iterable<string>,
): SurveyTemplate {
  const label = name.trim() || TOOL_LABELS[tool];
  return {
    id: uniqueId(label, taken, 'template'),
    name: label.slice(0, 120),
    family: TOOL_FAMILY[tool],
    tool,
    items: [...DEFAULT_ITEMS[tool]],
    fields: [],
    comparisons: [],
  };
}

/** What is wrong with a template, for the editor (empty when it can be saved). */
export function templateProblems(t: SurveyTemplate): string[] {
  const out: string[] = [];
  if (!t.name.trim()) out.push('Give the template a name.');
  if (TOOL_FAMILY[t.tool] !== t.family)
    out.push(`${TOOL_LABELS[t.tool]} is not a ${t.family} tool.`);
  const names = new Set<string>();
  for (const f of t.fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) out.push('Every field needs a name.');
    else if (names.has(key)) out.push(`Two fields are called "${f.name}".`);
    names.add(key);
    if (f.type === 'dropdown' && !(f.options && f.options.length > 0))
      out.push(`The dropdown "${f.name}" needs at least one choice.`);
  }
  const parsed = SurveyTemplate.safeParse(t);
  if (!parsed.success && out.length === 0)
    out.push(parsed.error.issues[0]?.message ?? 'The template is not valid.');
  return out;
}

// ---------------------------------------------------------------- items

/** Move an item (drag and drop), clamped to the list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  if (x === undefined) return out;
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

export const addItem = (t: SurveyTemplate, key: string): SurveyTemplate =>
  t.items.includes(key) || t.items.length >= 40 ? t : { ...t, items: [...t.items, key] };

export const removeItem = (t: SurveyTemplate, key: string): SurveyTemplate => ({
  ...t,
  items: t.items.filter((k) => k !== key),
});

// ---------------------------------------------------------------- custom fields

export function addField(
  t: SurveyTemplate,
  name: string,
  type: CustomField['type'],
  options?: string[],
): SurveyTemplate {
  if (t.fields.length >= 50) return t;
  const field: CustomField = {
    id: uniqueId(
      name,
      t.fields.map((f) => f.id),
      'field',
    ),
    name: name.trim().slice(0, 80) || 'Field',
    type,
    ...(type === 'dropdown' ? { options: cleanOptions(options ?? []) } : {}),
  };
  return { ...t, fields: [...t.fields, field] };
}

/** Dropdown choices: trimmed, no blanks, no repeats, at most 100. */
export const cleanOptions = (options: readonly string[]): string[] =>
  [...new Set(options.map((o) => o.trim().slice(0, 80)).filter((o) => o !== ''))].slice(0, 100);

export function updateField(
  t: SurveyTemplate,
  id: string,
  patch: Partial<Pick<CustomField, 'name' | 'type' | 'options'>>,
): SurveyTemplate {
  return {
    ...t,
    fields: t.fields.map((f) => {
      if (f.id !== id) return f;
      const next: CustomField = { ...f, ...patch };
      if (patch.options) next.options = cleanOptions(patch.options);
      if (next.type !== 'dropdown') delete next.options;
      else next.options ??= [];
      return next;
    }),
  };
}

export const removeField = (t: SurveyTemplate, id: string): SurveyTemplate => ({
  ...t,
  fields: t.fields.filter((f) => f.id !== id),
});

// ---------------------------------------------------------------- comparisons, style, bookmark

export const addComparison = (t: SurveyTemplate, p: ComparisonPreset): SurveyTemplate =>
  t.comparisons.length >= 10 ? t : { ...t, comparisons: [...t.comparisons, p] };

export const removeComparison = (t: SurveyTemplate, i: number): SurveyTemplate => ({
  ...t,
  comparisons: t.comparisons.filter((_, k) => k !== i),
});

export function setStyle(t: SurveyTemplate, style: MeasurementStyle | undefined): SurveyTemplate {
  const next = { ...t };
  if (style) next.style = style;
  else delete next.style;
  return next;
}

export function setDescription(t: SurveyTemplate, text: string): SurveyTemplate {
  const next = { ...t };
  const d = text.trim().slice(0, 2000);
  if (d) next.description = d;
  else delete next.description;
  return next;
}

export const toggleBookmark = (t: SurveyTemplate): SurveyTemplate => ({
  ...t,
  bookmarked: !t.bookmarked,
});

// ---------------------------------------------------------------- files and the library

/** Put a template into a file, replacing the one with its id. */
export function upsertTemplate(file: SurveyTemplatesFile, t: SurveyTemplate): SurveyTemplatesFile {
  const i = file.templates.findIndex((x) => x.id === t.id);
  const templates = [...file.templates];
  if (i >= 0) templates[i] = t;
  else templates.push(t);
  return { ...file, templates };
}

export const removeTemplate = (file: SurveyTemplatesFile, id: string): SurveyTemplatesFile => ({
  ...file,
  templates: file.templates.filter((t) => t.id !== id),
});

/** Copy a template into another file (project to library or back) under a free id. */
export function copyTemplate(t: SurveyTemplate, into: SurveyTemplatesFile): SurveyTemplatesFile {
  const id = uniqueId(
    t.id,
    into.templates.map((x) => x.id),
  );
  const copy = { ...t, id };
  delete copy.set;
  return upsertTemplate(into, copy);
}

export type TemplateSource = 'project' | 'user' | 'set';

export interface LibraryTemplate {
  template: SurveyTemplate;
  source: TemplateSource;
}

/**
 * Every template the toolbar and pickers offer: the project's, then the person's library, then
 * the enabled industry sets; a later one with an id already shown is left out.
 */
export function templateLibrary(
  project: SurveyTemplatesFile | null,
  user: SurveyTemplatesFile | null,
  sets: readonly SurveyTemplate[] = [],
): LibraryTemplate[] {
  const out: LibraryTemplate[] = [];
  const seen = new Set<string>();
  const take = (list: readonly SurveyTemplate[], source: TemplateSource) => {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ template: t, source });
    }
  };
  take(project?.templates ?? [], 'project');
  take(user?.templates ?? [], 'user');
  take(sets, 'set');
  return out;
}

export const bookmarks = (lib: readonly LibraryTemplate[]): LibraryTemplate[] =>
  lib.filter((l) => l.template.bookmarked);

// ---------------------------------------------------------------- measurements from templates

/**
 * Comparison items for a template's presets, with fresh ids. A design layer a preset leaves to pick
 * takes the site's pick (`picks`, `SurveySettings.designRoles`); a preset whose role has no pick
 * is left out (the app asks for the layer before a template is used, `missingRoles`).
 */
export function itemsFromPresets(
  presets: readonly ComparisonPreset[],
  taken: Iterable<string> = [],
  picks: RolePicks = {},
): ComparisonItem[] {
  const used = new Set(taken);
  return presets.flatMap((preset, i) => {
    const p = resolvePreset(preset, picks);
    if (!p) return [];
    const id = uniqueId(p.label ?? `comparison-${String(i + 1)}`, used, 'comparison');
    used.add(id);
    return [ComparisonItem.parse({ ...p, id })];
  });
}

export interface NewMeasurement {
  id: string;
  label: string;
  points: SitePoint[];
  scope: MeasurementScope;
  createdAt: string;
  createdBy?: string | undefined;
  folder?: string | undefined;
}

/**
 * A measurement drawn with a template (or with a bare tool when `t` is a tool); `picks` are the
 * site's design layers for the template's roles.
 */
export function measurementFrom(
  t: SurveyTemplate | MeasurementTool,
  m: NewMeasurement,
  picks: RolePicks = {},
) {
  const tool = typeof t === 'string' ? t : t.tool;
  const out: SurveyMeasurement = {
    id: m.id,
    family: TOOL_FAMILY[tool],
    tool,
    label: m.label.slice(0, 200) || TOOL_LABELS[tool],
    scope: m.scope,
    points: m.points,
    items: typeof t === 'string' ? [] : itemsFromPresets(t.comparisons, [], picks),
    results: [],
    createdAt: m.createdAt,
  };
  if (typeof t !== 'string') {
    out.template = t.id;
    if (t.style) out.style = t.style;
  }
  if (m.createdBy) out.createdBy = m.createdBy;
  if (m.folder) out.folder = m.folder;
  return out;
}

/**
 * Switch a measurement to another template of the same family: the tool, comparison presets the
 * measurement lacks and the template's style come over; custom field values are kept (fields the
 * new template lacks are hidden, not deleted). Null for a template of another family.
 */
export function changeTemplate(
  m: SurveyMeasurement,
  t: SurveyTemplate | null,
  now: string,
  picks: RolePicks = {},
): SurveyMeasurement | null {
  if (!t) {
    const next = { ...m, updatedAt: now };
    delete next.template;
    return next;
  }
  if (t.family !== m.family) return null;
  const have = new Set(m.items.map((i) => JSON.stringify([i.from, i.to])));
  const missing = t.comparisons.flatMap((preset) => {
    const p = resolvePreset(preset, picks);
    return p && !have.has(JSON.stringify([p.from, p.to])) ? [p] : [];
  });
  const room = Math.max(0, 20 - m.items.length);
  const next: SurveyMeasurement = {
    ...m,
    template: t.id,
    tool: t.tool,
    items: [
      ...m.items,
      ...itemsFromPresets(
        missing.slice(0, room),
        m.items.map((i) => i.id),
      ),
    ],
    updatedAt: now,
  };
  if (t.style) next.style = t.style;
  return next;
}
