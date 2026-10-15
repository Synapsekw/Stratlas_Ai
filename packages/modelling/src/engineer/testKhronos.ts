/**
 * The Khronos glTF validator (`gltf-validator`, a dev dependency) as a `KhronosValidator`, for
 * tests: the app does not ship it, so `validateGlb` takes it as a parameter.
 */
import { validateBytes } from 'gltf-validator';
import type { KhronosValidator } from './validate';

const SEVERITY = ['error', 'warning', 'information', 'hint'];

export const khronos: KhronosValidator = async (glb) => {
  const r = await validateBytes(glb, { format: 'glb', maxIssues: 50, writeTimestamp: false });
  return {
    errors: r.issues.numErrors,
    warnings: r.issues.numWarnings,
    messages: r.issues.messages
      .filter((m) => m.severity <= 1)
      .map(
        (m) =>
          `${SEVERITY[m.severity] ?? 'issue'} ${m.code}: ${m.message}${m.pointer ? ` (${m.pointer})` : ''}`,
      ),
  };
};
