/**
 * The engineering model entry points (setup, run, review): on since the whole flow landed (plan
 * Task 39). Place model does not depend on this.
 */
export const ENGINEERING_MODEL_UI = true;

/** The flag as a plain boolean (the constant is fixed per build). */
export const engineeringUiOn = (): boolean => ENGINEERING_MODEL_UI;

/** Layer kinds an engineering model can be made from. */
export const ENGINEERING_SOURCES: readonly string[] = ['pointcloud', 'mesh', 'photos'];
