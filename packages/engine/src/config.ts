import type { AssetRef } from '@aio/schema';
import { assetUrl } from '@aio/workspace';

/** Renderer quality the graphics preset sets (see the app's GPU tiers). */
export interface StageQuality {
  /** Upper bound on the device pixel ratio the canvas renders at. */
  maxPixelRatio: number;
  /** Edge of the sun's shadow map, texels (capped by the GPU's texture size). */
  shadowMapSize: number;
  /** Shadow edge softness (PCF filter radius), texels. */
  shadowSoftness: number;
  /** Water: layered animated waves, or one still layer for integrated graphics. */
  water: 'full' | 'simple';
  /** Frames per second the water animates at while nothing else redraws; 0 keeps it still. */
  waterFps: number;
  /**
   * 4x multisampling of the 3D view (default on). Off on integrated graphics, where the resolve
   * costs a fifth of the frame and four times the colour memory. Read when a stage is created.
   */
  antialias?: boolean;
}

/** Words the engine shows on the stage (photo and panorama markers); keys of the app catalogue. */
export type EngineTextKey =
  | 'stage.markers.photo'
  | 'stage.markers.photos'
  | 'stage.markers.pano'
  | 'stage.markers.panos'
  | 'stage.markers.open'
  | 'stage.markers.list'
  | 'stage.markers.more'
  | 'stage.markers.timeRange';

export type EngineText = (key: EngineTextKey, vars?: Record<string, string | number>) => string;

/**
 * Memory limits the graphics preset sets: the largest texture edge a model or raster keeps (larger
 * images are scaled down before upload) and how many fine ortho tiles stream around the view.
 */
export interface EngineMemory {
  /** Largest texture edge, pixels (also capped by the GPU's own limit). */
  maxTextureSize: number;
  /** Fine tiles of a tiled ortho wanted around the view; a few more stay loaded. */
  rasterTiles: number;
}

/** A stage lost its WebGL context (GPU reset or out of memory) or got it back. */
export interface GpuEvent {
  type: 'context-lost' | 'context-restored';
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
  /** Stage words from the app's catalogue (`t` of @aio/ui); the default shows the keys. */
  text: EngineText;
  /** Texture and tile limits for assets loaded from now on. */
  memory: EngineMemory;
  /** Told when a stage loses or regains its WebGL context. */
  onGpuEvent: ((e: GpuEvent) => void) | null;
}

const config: EngineConfig = {
  resolveUrl: assetUrl,
  dracoDecoderPath: null,
  devTools: false,
  quality: {
    maxPixelRatio: 1.5,
    shadowMapSize: 4096,
    shadowSoftness: 2.5,
    water: 'full',
    waterFps: 30,
  },
  text: (key, vars) => (vars ? `${key} ${Object.values(vars).map(String).join(' ')}` : key),
  memory: { maxTextureSize: 16384, rasterTiles: 9 },
  onGpuEvent: null,
};

/** Configure the engine before mounting SceneView (dev harness, tests, app composition). */
export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(config, patch);
}

export function engineConfig(): Readonly<EngineConfig> {
  return config;
}
