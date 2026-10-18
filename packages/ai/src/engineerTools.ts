/** Read-only access to the finite, approved measurement inventory. No paths or execution tools. */
import type { ComponentObservation } from '@aio/schema';
import { tool } from 'ai';
import { z } from 'zod';

export const ReadComponentsInput = z
  .object({ ids: z.array(z.string().max(68)).min(1).max(16) })
  .strict();

export function measurementRecords(observations: readonly ComponentObservation[]) {
  const note = (s: string) =>
    /[\\]|[A-Za-z]:|https?:\/\//.test(s) ? '[Local path omitted]' : s.slice(0, 200);
  const refs = new Map(
    [...new Set(observations.flatMap((o) => o.sources.map((s) => s.ref)))].map((ref, i) => [
      ref,
      /^(img-|dxf-)[a-zA-Z0-9_-]+$/.test(ref) ? ref : `source-${i + 1}`,
    ]),
  );
  return observations.map(
    ({ id, kind, centre, size, azimuthDeg, tiltDeg, quality, parent, path, notes, sources }) => ({
      id,
      kind,
      centre,
      size,
      azimuthDeg,
      tiltDeg,
      quality: Object.fromEntries(
        Object.entries(quality).map(([field, q]) => [
          field,
          {
            basis: q.basis,
            support: q.support,
            residualM: q.residualM,
            coverage: q.coverage,
            ...(q.note ? { note: note(q.note) } : {}),
          },
        ]),
      ),
      ...(parent ? { parent } : {}),
      ...(path ? { path } : {}),
      ...(notes?.length ? { notes: notes.slice(0, 8).map(note) } : {}),
      sources: sources.slice(0, 16).map((s) => ({
        kind: s.kind,
        ref: refs.get(s.ref),
        ...(s.view ? { view: note(s.view) } : {}),
      })),
    }),
  );
}

export function componentTools(observations: readonly ComponentObservation[]) {
  const records = measurementRecords(observations);
  return {
    read_components: tool({
      description:
        'Read up to 16 approved measured components by their observation IDs. Coordinates are fixed project-local metres. Returns field-level uncertainty. Cannot change geometry or read files.',
      inputSchema: ReadComponentsInput,
      execute: (input) => {
        const { ids } = ReadComponentsInput.parse(input);
        const chosen = new Set(ids);
        return {
          components: records.filter((o) => chosen.has(o.id)),
          missing: ids.filter((id) => !records.some((o) => o.id === id)),
        };
      },
    }),
  };
}
