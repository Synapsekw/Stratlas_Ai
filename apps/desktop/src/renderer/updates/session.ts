import type { AioBridge } from '@aio/schema';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { createWebsiteUpdateStore, type WebsiteUpdates } from './store';
const aio = window.aio as AioBridge | undefined;
export const websiteUpdates = createWebsiteUpdateStore(
  bridge,
  aio ? (listener) => aio.on('websiteUpdate:status', listener) : undefined,
);
export function useWebsiteUpdates<T>(selector: (state: WebsiteUpdates) => T): T {
  return useStore(websiteUpdates, selector);
}
