import type { PipelineJobs } from '@aio/project/builder';
import type { IpcRequest, IpcResponse, PipelineName } from '@aio/schema';

/** Builder conversions (raw import) and the pipeline that runs each in the pipeline pack. */
export const BUILDER_PIPELINES: Readonly<Record<string, PipelineName>> = {
  'pointcloud.toCopc': 'pointcloud.to_copc',
  'drawing.import': 'drawing.import',
};

/** Keys of the builder's job params each pipeline takes (`projectRoot` becomes the job project). */
const PARAM_KEYS: Readonly<Partial<Record<PipelineName, readonly string[]>>> = {
  'pointcloud.to_copc': ['src', 'out', 'epsg', 'origin'],
  // the drawing's units and placement are set in the Model builder afterwards
  'drawing.import': ['src'],
};

export interface JobStarter {
  list(): Promise<IpcResponse<'jobs:list'>>;
  start(req: IpcRequest<'jobs:start'>): Promise<IpcResponse<'jobs:start'>>;
}

/**
 * The raw import's pipeline seam over the job runner (`jobs:start`): a LAS/LAZ/E57 file becomes
 * a `pointcloud.to_copc` job in the Jobs panel. Conversions the pack does not offer yet (large
 * rasters, video transcodes) fail with a message the import list shows.
 */
export function builderPipelineJobs(runner: JobStarter): PipelineJobs {
  return {
    available: async () => (await runner.list()).runtime.found,
    start: async (method, params) => {
      const pipeline = BUILDER_PIPELINES[method];
      if (!pipeline) {
        throw new Error(
          'The pipeline pack cannot convert this file type yet. Convert it with another tool, then import the result.',
        );
      }
      const project = params.projectRoot;
      if (typeof project !== 'string' || !project)
        throw new Error('No project folder to convert into.');
      const keys = PARAM_KEYS[pipeline] ?? [];
      const picked = Object.fromEntries(
        keys.filter((k) => params[k] !== undefined).map((k) => [k, params[k]]),
      );
      const r = await runner.start({ pipeline, project, params: picked });
      if (!r.ok) throw new Error(r.error);
      return { jobId: r.job.id };
    },
  };
}
