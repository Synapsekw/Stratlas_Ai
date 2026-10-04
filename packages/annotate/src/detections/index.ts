/**
 * Detection review (BLD-5): model, adapter for `aio.detections/1`, the review state machine,
 * acceptance into issues, contact sheet windowing and the mask assist seam. Pure, no React:
 * the main process imports it as `@aio/annotate/detections`.
 */
export * from './model';
export * from './geometry';
export * from './review';
export * from './accept';
export * from './grid';
export * from './mask';
