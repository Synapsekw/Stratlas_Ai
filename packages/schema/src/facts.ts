/**
 * The project fact index (intelligence review Wave 3, M1; study insight.md 5.6 and 5.7).
 *
 * A derived, rebuildable index of typed facts about one project, kept by main in SQLite with FTS5
 * (`@aio/facts`). It is never a source of truth: it lives in userData, it is built from the
 * project's files and journal, and deleting it and building again gives the same index. These are
 * the shapes main hands out over `facts:*` (the agent's `query_facts` and `history_of`, the Project
 * tab search) and that later readers (per-project agent memory, the local MCP server) read.
 */
import { z } from 'zod';
import { IsoDate, IsoTime } from './common';

/** Bumped when the table layout or the extraction rules change: an older index is rebuilt. */
export const FACT_INDEX_VERSION = 2;

/** What a fact is about. */
export const FACT_KINDS = [
  /** A survey date (manifest capture). */
  'survey',
  /** A layer of the manifest (model, cloud, photos, walk, ...). */
  'layer',
  /** A photo with a position. */
  'photo',
  /** A survey measurement (`survey/measurements.json`). */
  'measurement',
  /** A measurement's volume on one survey date. */
  'volume',
  /** A detection of a pass (`detections/*.json`) and its review. */
  'detection',
  /** An issue (`issues.json`). */
  'issue',
  /** A survey QA result (`survey/qa/<capture>.json`). */
  'qa',
  /** A photogrammetry accuracy report. */
  'accuracy',
  /** A change set between two survey dates (`change/*.json`). */
  'change-set',
  /** One item of a change set. */
  'change',
  /** A thermal hot spot or hot-spot candidate. */
  'hotspot',
  /** A 360 walk. */
  'walk',
  /** A telecom antenna as one survey date measured it (`telecom/history/<capture>.json`). */
  'antenna',
  /** A journal op: who changed what, when. */
  'event',
  /** A note the person keeps about the project for the agent (`ai/memory.json`, A3). */
  'note',
] as const;
export const FactKind = z.enum(FACT_KINDS);
export type FactKind = z.infer<typeof FactKind>;

/**
 * One fact. `subject` names the thing it is about as `<record kind>:<id>` (the journal's record
 * kinds where there is one: `issue:I1`, `measurement:m-3`, `detection:d-7`, `survey:c-2`,
 * `change-set:cs-1`, `photo:<layer>/<photo>`), so facts of several kinds about one thing share it.
 */
export const Fact = z.object({
  /** Stable id: the same project files give the same id. */
  id: z.string().min(1).max(400),
  kind: FactKind,
  subject: z.string().min(1).max(400),
  /** Short name ("North stockpile", "Crack D012", "Survey 12 Jul"). */
  label: z.string().max(400),
  /** Searchable words besides the label (notes, classes, statuses). */
  text: z.string().max(4000).optional(),
  /** The survey date (capture id) it belongs to. */
  capture: z.string().max(200).optional(),
  /** That capture's date. */
  date: IsoDate.optional(),
  /** When it happened or was computed. */
  at: IsoTime.optional(),
  /** Its main figure, in SI (`unit`). */
  value: z.number().optional(),
  unit: z.string().max(16).optional(),
  /** Review or QA state (`accepted`, `draft`, `pass`, `hold`, `confirmed`, ...). */
  status: z.string().max(40).optional(),
  /** Who or what made it (`human`, `ai`, `model`, `agent`, `import`, `pipeline`). */
  source: z.string().max(40).optional(),
  /** Project-relative path of the file it was read from. */
  evidence: z.string().max(400),
  /** The journal op (event facts). */
  op: z.string().max(200).optional(),
  /** Where it is, project CRS easting and northing in metres. */
  e: z.number().optional(),
  n: z.number().optional(),
});
export type Fact = z.infer<typeof Fact>;

/** How two subjects relate. */
export const FACT_RELATIONS = [
  /** A detection, issue or hot spot seen on a photo. */
  'on-photo',
  /** Anything that belongs to a survey date. */
  'on-survey',
  /** A photo or walk of a layer. */
  'in-layer',
  /** A detection or hot spot that became an issue, or an issue's track. */
  'issue',
  /** A change item of a change set; a change set's two dates. */
  'in-set',
  /** A change item about an issue or detection; a project note about the subject it names. */
  'about',
  /** A volume's QA result (the QA of its survey date). */
  'qa',
  /** A point thing inside a measurement's outline on the same date (an issue on a pile). */
  'inside',
] as const;
export const FactRelation = z.enum(FACT_RELATIONS);
export type FactRelation = z.infer<typeof FactRelation>;

export const FactLink = z.object({
  from: z.string().min(1).max(400),
  to: z.string().min(1).max(400),
  rel: FactRelation,
});
export type FactLink = z.infer<typeof FactLink>;

/** A query over the index; every field narrows. */
export const FactQuery = z
  .object({
    /** Full-text words (FTS5 on label and text, prefix matched); empty: no text filter. */
    text: z.string().max(200).optional(),
    kinds: z.array(FactKind).max(FACT_KINDS.length).optional(),
    subject: z.string().max(400).optional(),
    capture: z.string().max(200).optional(),
    /** Survey date or event day on or after / on or before (ISO date). */
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    status: z.string().max(40).optional(),
    /** Within `radiusM` of a point (project CRS). */
    near: z
      .object({ e: z.number(), n: z.number(), radiusM: z.number().positive().max(100_000) })
      .strict()
      .optional(),
    /** Default 50, at most 500. */
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type FactQuery = z.infer<typeof FactQuery>;

/**
 * One subject's history: its facts and the facts linked to it, in date order. Each list holds the
 * newest `limit` entries (oldest first); `totals` counts every entry, so a reader can say how
 * many older ones were left out.
 */
export const FactHistory = z.object({
  subject: z.string(),
  /** The subject's own facts (all kinds but events), oldest first. */
  facts: z.array(Fact),
  /** Facts of linked subjects, with the relation, oldest first. */
  linked: z.array(z.object({ rel: FactRelation, fact: Fact })),
  /** Journal ops on the subject, oldest first. */
  events: z.array(Fact),
  totals: z.object({
    facts: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
});
export type FactHistory = z.infer<typeof FactHistory>;

/** Why the index cannot answer: the renderer and the agent map it to their own words. */
export const FactsUnavailable = z.enum(['not-built', 'package', 'not-open']);
export type FactsUnavailable = z.infer<typeof FactsUnavailable>;

export const FactIndexState = z.enum(['none', 'building', 'ready', 'error']);
export type FactIndexState = z.infer<typeof FactIndexState>;

/** What main knows about a project's index. */
export const FactIndexStatus = z.object({
  state: FactIndexState,
  /** When it was last built or updated. */
  builtAt: IsoTime.optional(),
  /** Facts per kind. */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  links: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
});
export type FactIndexStatus = z.infer<typeof FactIndexStatus>;
