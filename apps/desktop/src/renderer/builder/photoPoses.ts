import {
  createPhotosAdapter,
  getAdapter,
  registerAdapter,
  type LayerAdapter,
  type LayerHandle,
} from '@aio/engine';
import { correctedPhoto } from '@aio/geo';
import type { OrientationFile } from '@aio/schema';
import { workspace as appWorkspace, type Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';

/*
 * Photos in 3D drawn with their hand corrections ("Align photo to map", orientation.json): the
 * engine's own photos adapter, given each set's photos with corrected poses and built again when
 * that set's corrections change. The engine and the photo records stay as they are.
 */

const fixesOf = (o: OrientationFile | null, layerId: string) => o?.photos[layerId];

export function createCorrectedPhotosAdapter(
  store: StoreApi<Workspace> = appWorkspace,
): LayerAdapter<'photos'> {
  const inner = createPhotosAdapter(store);
  return {
    kind: 'photos',
    async create(layer, ctx): Promise<LayerHandle> {
      let handle: LayerHandle | null = null;
      let visible = true;
      let disposed = false;
      let built = 0;
      const build = async () => {
        const mine = ++built;
        const fixes = fixesOf(store.getState().orientation, layer.id);
        const items = fixes ? layer.items.map((p) => correctedPhoto(p, fixes[p.id])) : layer.items;
        const h = await inner.create({ ...layer, items }, ctx);
        if (disposed || mine !== built) {
          h.dispose();
          return;
        }
        handle?.dispose();
        handle = h;
        h.setVisible(visible);
      };
      let last = fixesOf(store.getState().orientation, layer.id);
      const off = store.subscribe((s) => {
        const now = fixesOf(s.orientation, layer.id);
        if (now === last) return;
        last = now;
        void build();
      });
      await build();
      return {
        setVisible(v: boolean) {
          visible = v;
          handle?.setVisible(v);
        },
        dispose() {
          disposed = true;
          off();
          handle?.dispose();
          handle = null;
        },
      };
    },
  };
}

/** Draw photos with their corrections: register before the engine's own adapters. */
export function registerCorrectedPhotos(): void {
  if (!getAdapter('photos')) registerAdapter(createCorrectedPhotosAdapter());
}
