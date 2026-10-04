import type { AssetRef } from '@aio/schema';
import { assetUrl } from '@aio/workspace';

/** Renderer quality the graphics preset sets (see the app's GPU tiers). */
export interface StageQuality {
  /** Upper bound on the device pixel ratio the canvas renders at. */
  maxPixelRatio: number;
  /** Edge of the sun's shadow map, texels (capped by the GPU's texture size). */
  shadowMapSize: number;
}

export interface EngineConfig {
  /** Turns a project asset into a fetchable URL. Default: aio://project/<id>/... */
  resolveUrl: (projectId: string, ref: AssetRef) => string;
  /** Folder with the DRACO decoder (draco_decoder.js / .wasm). Unset: DRACO meshes are refused. */
  dracoDecoderPath: string | null;
  /** Development build: extra diagnostics. The perf HUD (Ctrl+Shift+F) is always available. */
  devTools: boolean;
  /** Quality for stages created from now on; `EngineStage.setQuality` changes a live one. */
  quality: StageQuality;
}

const config: EngineConfig = {
  resolveUrl: assetUrl,
  dracoDecoderPath: null,
  devTools: false,
  quality: { maxPixelRatio: 1.5, shadowMapSize: 4096 },
};

/** Configure the engine before mounting SceneView (dev harness, tests, app composition). */
export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(config, patch);
}

export function engineConfig(): Readonly<EngineConfig> {
  return config;
}
