/**
 * The main-process side of the antenna AI labelling: what `createAgentRuntime` asks for. The
 * project's AI policy and photo consent are read from the manifest on disk at the moment of
 * sending (the same reader as the engineering step), and the crops are the files the geometry job
 * wrote under `telecom/crops`, only for units that are in the inventory.
 */
import type { TelecomLabelHost } from '@aio/ai/main';
import { ANTENNA_CROPS_DIR, type AiPolicy } from '@aio/schema';
import { createHash } from 'node:crypto';
import { evidencePolicy } from './evidencePolicy';
import { readAntennaCrop, readAntennas } from './telecom';
import type { SurveyProjects } from './survey';

export function telecomLabelHost(o: {
  projects: SurveyProjects;
  /** The package's AI policy (its header); folder projects read their manifest. */
  packagePolicy: (projectId: string) => AiPolicy;
  resize?: (dataUrl: string, maxPx: number) => Promise<string>;
}): TelecomLabelHost {
  return {
    policy: async (projectId) => {
      if (o.projects.package(projectId)) {
        // a package is read-only and holds no crops: nothing of it is ever sent
        return { ai: o.packagePolicy(projectId), photos: false };
      }
      const root = o.projects.root(projectId);
      if (root === undefined) return null;
      const p = await evidencePolicy(root);
      return 'error' in p ? p : { ai: p.ai, photos: p.photos };
    },
    crops: async (projectId, unitIds) => {
      const root = o.projects.root(projectId);
      if (root === undefined) return [];
      const read = await readAntennas(o.projects, projectId);
      if (!read.ok || !read.file) return [];
      const known = new Set(read.file.units.map((u) => u.id));
      const out: { unitId: string; path: string; dataUrl: string; sha256: string }[] = [];
      for (const unitId of unitIds) {
        if (!known.has(unitId)) continue;
        const crop = await readAntennaCrop(root, unitId);
        if (!crop) continue;
        out.push({
          unitId,
          path: `${ANTENNA_CROPS_DIR}/${unitId}.jpg`,
          dataUrl: `data:image/jpeg;base64,${crop.bytes.toString('base64')}`,
          sha256: createHash('sha256').update(crop.bytes).digest('hex'),
        });
      }
      return out;
    },
    ...(o.resize ? { resize: o.resize } : {}),
  };
}
