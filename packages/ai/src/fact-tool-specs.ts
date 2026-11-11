/**
 * Read tools over the project fact index (M1, intelligence review Wave 3): `query_facts` searches
 * the typed facts main keeps for the open project, `history_of` reads one thing's facts, linked
 * facts and journal ops in date order. Specs here (both processes); executors in fact-tools.ts,
 * over `window.aio` (`facts:query`, `facts:history`).
 */
import { FactKind, IsoDate } from '@aio/schema';
import { z } from 'zod';
import type { ToolSpec } from './tools';

export const factToolInputs = {
  query_facts: z
    .object({
      text: z
        .string()
        .max(200)
        .optional()
        .describe('Words to search for in names, notes, classes and statuses'),
      kinds: z
        .array(FactKind)
        .min(1)
        .max(FactKind.options.length)
        .optional()
        .describe('Only these kinds of fact'),
      date: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Only facts of this survey date (capture id, date YYYY-MM-DD or name)'),
      from: IsoDate.optional().describe('Survey date or event day on or after (YYYY-MM-DD)'),
      to: IsoDate.optional().describe('Survey date or event day on or before (YYYY-MM-DD)'),
      status: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('Only this review or QA state, e.g. accepted, draft, pass, hold'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  history_of: z
    .object({
      subject: z
        .string()
        .min(1)
        .max(400)
        .describe(
          'A subject id from query_facts (e.g. issue:I1, measurement:m-3) or a name (e.g. "Stockpile SP1")',
        ),
    })
    .strict(),
} as const;

export type FactToolName = keyof typeof factToolInputs;
export type FactToolInput<N extends FactToolName> = z.output<(typeof factToolInputs)[N]>;

export const FACT_TOOL_SPECS: ToolSpec[] = [
  {
    meta: {
      name: 'query_facts',
      description:
        'Search what the project knows: typed facts (survey dates, layers, measurements, volumes, detections, issues, QA, changes, hot spots, walks, journal events) by words, kind, survey date, day range or status. Each fact has its subject id for history_of.',
      scope: 'project',
      risk: 'read',
    },
    input: factToolInputs.query_facts,
  },
  {
    meta: {
      name: 'history_of',
      description:
        "One thing's history, oldest first: its own facts (figures per survey date, states), the facts linked to it (its photos, its dates, an issue inside a pile) and the journal ops on it (who changed what, when).",
      scope: 'project',
      risk: 'read',
    },
    input: factToolInputs.history_of,
  },
];

/** The fact tools: offered only while the project's fact index is ready (`fitsProject`). */
export const FACT_TOOLS: ReadonlySet<string> = new Set(FACT_TOOL_SPECS.map((s) => s.meta.name));
