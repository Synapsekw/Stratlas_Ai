/**
 * Ground at the tower base when the antenna file has none (spec D4). The job (python
 * `aio_pipelines/rf/inputs.py`, `ground_from_dsm`) is the source of truth: it takes the first
 * project DSM (COG) that covers the tower and uses a low percentile of the DSM within a radius of
 * the base. It never samples the terrain, and never the DSM at the one point (that is the tower
 * top). The preview must use the same numbers.
 */

/** Radius around the tower base, metres (python `DSM_GROUND_RADIUS_M`). */
export const DSM_GROUND_RADIUS_M = 30;
/** Percentile of the DSM values inside that radius (python `DSM_GROUND_PERCENTILE`). */
export const DSM_GROUND_PERCENTILE = 5;
