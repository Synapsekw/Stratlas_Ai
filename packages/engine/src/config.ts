import type { AssetRef } from '@aio/schema';
import { assetUrl } from '@aio/workspace';

export interface EngineConfig {
  /** Turns a project asset into a fetchable URL. Default: aio://project/<id>/... */
  resolveUrl: (projectId: string, ref: AssetRef) => string;
  /** Folder with the DRACO decoder (draco_decoder.js / .wasm). Unset: DRACO meshes are refused. */
  dracoDecoderPath: string | null;
  /** Show the frame-time overlay shortcut (Ctrl+Shift+F). */
  devTools: boolean;
}

const config: EngineConfig = {
  resolveUrl: assetUrl,
  dracoDecoderPath: null,
  devTools: false,
};

/** Configure the engine before mounting SceneView (dev harness, tests, app composition). */
export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(config, patch);
}

export function engineConfig(): Readonly<EngineConfig> {
  return config;
}
