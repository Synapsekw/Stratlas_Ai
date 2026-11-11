/**
 * The add-on model packs as the renderer knows them: what is installed, what the catalogue offers,
 * the install that runs. Settings, Models and detection (`screens/settings/Addons.tsx`) installs
 * and removes them; the cleanup panel and the photo menu ask what is installed.
 */
import type { AioBridge } from '@aio/schema';
import { useStore } from 'zustand';
import { createAddonsStore, type Addons } from './addonsStore';
import { bridge } from './shell';

export type { Addons } from './addonsStore';
export { installedOf } from './addonsStore';

const aio = window.aio as AioBridge | undefined;

/** The app's one store of the add-ons. */
export const addons = createAddonsStore(bridge, aio?.on.bind(aio));

export function useAddons<T>(selector: (s: Addons) => T): T {
  return useStore(addons, selector);
}
