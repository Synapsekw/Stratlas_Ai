import { registerRendererTool, ToolError, type ToolRunResult } from '@aio/ai';
import { findDrawing, findPart, partSummary, type DimensionKey } from '@aio/modelling';
import type { PartStatus, ProcModel, ProcPart, ProcPartKind, Vec3 } from '@aio/schema';
import type { StoreApi } from 'zustand';
import type { Modeller } from './store';

/** Inputs as `@aio/ai` `modellingToolInputs` checks them before an executor runs. */
interface ModellingToolInputs {
  list_model_parts: { model?: string; status?: PartStatus };
  propose_model_parts: {
    model?: string;
    from: 'drawing' | 'agent';
    drawing?: string;
    tags?: string[];
    classes?: string[];
    parts?: Record<string, unknown>[];
  };
  fit_primitives: {
    layer: string;
    kinds?: ProcPartKind[];
    region?: { min: Vec3; max: Vec3 };
    model?: string;
  };
  edit_model_part: {
    model?: string;
    part: string;
    status?: PartStatus;
    set?: Partial<Record<'tag' | 'name' | 'class', string> & Record<DimensionKey, number>>;
  };
  build_model: { model?: string; draft?: boolean };
  view_plan: { drawing?: string };
}
/**
 * Executors of the model builder's agent tools (specs in `@aio/ai` `modelling-tools.ts`). They act
 * through the Model builder store, so the screen shows every draft the agent makes.
 *
 * Founder decision 5: plan images and drawing content reach a cloud model only when the project
 * allows it (`aiCloudDrawings`, off by default). With a cloud route and the policy off, results
 * name parts by id, kind and status only (no tags, sizes or places read from a drawing) and
 * `view_plan` refuses. A local model always gets them: nothing leaves the computer.
 */

export const KEEP_LOCAL =
  'This project keeps plan images and drawings on this computer. A person can allow cloud AI for drawings in the Model builder, or use a local model.';

export interface ModellingToolHost {
  modeller: StoreApi<Modeller>;
  /** Whether the agent's model runs in the cloud (`ai:status`). */
  cloudRoute: () => Promise<boolean>;
  /** The project policy `aiCloudDrawings`. */
  cloudDrawings: () => boolean;
  /** A data URL of a project file (the plan picture). */
  dataUrl: (path: string) => Promise<string>;
  /** Point cloud layers of the open project, for `fit_primitives`. */
  clouds: () => { id: string; name: string }[];
}

const DIMENSIONS: readonly DimensionKey[] = [
  'x',
  'y',
  'z',
  'radius',
  'height',
  'roofHeight',
  'length',
  'width',
  'yawDeg',
  'diameter',
];

const fail = (e: string | { error: string } | null): void => {
  if (e === null) return;
  throw new ToolError(typeof e === 'string' ? e : e.error);
};

/** What the model may read about a part. */
function describePart(p: ProcPart, share: boolean): Record<string, unknown> {
  const base = { id: p.id, kind: p.kind, status: p.status, by: p.origin.by };
  if (!share && p.origin.by === 'drawing') return base;
  return {
    ...base,
    ...(p.tag ? { tag: p.tag } : {}),
    ...(p.name ? { name: p.name } : {}),
    ...(p.class ? { class: p.class } : {}),
    size: partSummary(p),
    ...(p.origin.by === 'fit'
      ? { residualM: p.origin.residualM, inlierShare: p.origin.inlierShare }
      : {}),
  };
}

export function registerModellingTools(host: ModellingToolHost): void {
  const { modeller } = host;
  const share = async () => !(await host.cloudRoute()) || host.cloudDrawings();

  async function model(id: string | undefined): Promise<ProcModel> {
    const s = modeller.getState();
    if (id && s.model?.id !== id) fail(await s.openModel(id));
    if (!id && !modeller.getState().model && modeller.getState().models.length === 0) {
      await modeller.getState().refresh();
    }
    const m = id ? modeller.getState().model : await modeller.getState().ensureModel();
    if (!m) throw new ToolError(modeller.getState().error ?? 'No model is open.');
    return m;
  }

  const result = (r: unknown, summary: string): ToolRunResult => ({ result: r, summary });

  registerRendererTool('list_model_parts', async (raw) => {
    const input = raw as ModellingToolInputs['list_model_parts'];
    const m = await model(input.model);
    const may = await share();
    const parts = m.parts.filter((p) => !input.status || p.status === input.status);
    return result(
      { model: m.id, parts: parts.map((p) => describePart(p, may)) },
      `${String(parts.length)} part${parts.length === 1 ? '' : 's'}`,
    );
  });

  registerRendererTool('propose_model_parts', async (raw, ctx) => {
    const input = raw as ModellingToolInputs['propose_model_parts'];
    await model(input.model);
    const may = await share();
    const r =
      input.from === 'drawing'
        ? await modeller.getState().addFromDrawing(input.drawing, {
            ...(input.tags ? { tags: input.tags } : {}),
            ...(input.classes ? { classes: input.classes } : {}),
          })
        : await modeller
            .getState()
            .addAgentParts(input.parts ?? [], `agent-${ctx.now().toISOString()}`);
    if ('error' in r) throw new ToolError(r.error);
    modeller.setState({ open: true, selected: r.added[0]?.id ?? null });
    const n = r.added.length;
    return result(
      {
        added: r.added.map((p) => describePart(p, may)),
        status: 'draft',
        next: 'A person accepts or rejects the drafts in the Model builder.',
        ...(may ? {} : { note: KEEP_LOCAL }),
      },
      `${String(n)} draft part${n === 1 ? '' : 's'}`,
    );
  });

  registerRendererTool('fit_primitives', async (raw) => {
    const input = raw as ModellingToolInputs['fit_primitives'];
    await model(input.model);
    const key = input.layer.toLowerCase();
    const cloud = host.clouds().find((c) => c.id === input.layer || c.name.toLowerCase() === key);
    if (!cloud) {
      const names = host.clouds().map((c) => c.name);
      throw new ToolError(
        names.length
          ? `No point cloud "${input.layer}". Point clouds: ${names.join(', ')}.`
          : 'This project has no point cloud.',
      );
    }
    modeller.setState({ open: true });
    fail(
      await modeller.getState().fitCloud({
        layer: cloud.id,
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.region ? { region: input.region } : {}),
      }),
    );
    const s = modeller.getState();
    return result({ model: s.model?.id, notice: s.notice }, s.notice ?? 'Fitted');
  });

  registerRendererTool('edit_model_part', async (raw) => {
    const input = raw as ModellingToolInputs['edit_model_part'];
    const m = await model(input.model);
    const part = findPart(m, input.part);
    if (!part) throw new ToolError(`The model has no part "${input.part}".`);
    const s = modeller.getState();
    const set = input.set ?? {};
    const text: Record<string, string> = {};
    for (const k of ['tag', 'name', 'class'] as const) {
      const v = set[k];
      if (v !== undefined) text[k] = v;
    }
    if (Object.keys(text).length) fail(await s.editPart(part.id, text));
    for (const k of DIMENSIONS) {
      const v = set[k];
      if (v !== undefined) fail(await modeller.getState().editDimension(part.id, k, v));
    }
    if (input.status) fail(await modeller.getState().setStatus([part.id], input.status));
    modeller.setState({ open: true, selected: part.id });
    const now = modeller.getState().model?.parts.find((p) => p.id === part.id);
    return result(
      { part: now ? describePart(now, await share()) : { id: part.id } },
      `Changed ${part.id}`,
    );
  });

  registerRendererTool('build_model', async (raw) => {
    const input = raw as ModellingToolInputs['build_model'];
    await model(input.model);
    const r = await modeller.getState().build(input.draft ?? false);
    if ('error' in r) throw new ToolError(r.error);
    return result({ layer: r.layer, draft: input.draft ?? false }, `Built ${r.layer}`);
  });

  registerRendererTool('view_plan', async (raw) => {
    const input = raw as ModellingToolInputs['view_plan'];
    if (!(await share())) throw new ToolError(KEEP_LOCAL);
    const d = findDrawing(modeller.getState().drawings(), input.drawing);
    if (!d) throw new ToolError('No drawing is imported yet. Import a DXF drawing first.');
    const image = await host.dataUrl(d.plan);
    return result({ image, drawing: d.name }, `Plan of ${d.name}`);
  });
}
