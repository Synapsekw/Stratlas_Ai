/**
 * The Globe (M10 stream G6): library projects as sites on the Earth (`globe:sites`, computed from
 * their manifests in the data process), the installed imagery and terrain packs for its menus
 * (`globe:packs`), and its preferences in userData `globe.json` (`aio.globe-settings/1`). The Globe
 * makes no request of its own (no Cesium ion, no default imagery or terrain). G0 stubs: no raster
 * pack is known yet, the settings are the defaults, and the rest answers "not available yet".
 */
import { defaultGlobeSettings } from '@aio/schema';
import { notYet, type Handle } from './notYet';

export interface GlobeIpcDeps {
  handle: Handle;
}

export function registerGlobeIpc({ handle }: GlobeIpcDeps): void {
  const what = 'The Globe';
  handle('globe:sites', () => notYet(what));
  handle('globe:packs', () => ({ ok: true as const, imagery: [], terrain: [] }));
  handle('globe:getSettings', () => ({ ok: true as const, settings: defaultGlobeSettings() }));
  handle('globe:setSettings', () => notYet(what));
}
