/**
 * @aio/change (M8 stream C1, FUS-12): change between two capture dates. Change sets
 * (`aio.change/1`) and their register, issue, detection and map vector change in TypeScript, and
 * the Changes panel. Imagery, surface, point cloud, model and frame change (C2 to C4) plug in
 * through the producer registry below, so they never edit the panel.
 */
export * from './core';
export {
  changeProducers,
  registerChangeProducer,
  type ChangePairContext,
  type ChangeProducer,
  type ChangeRunResult,
} from './producers';
