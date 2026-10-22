/**
 * The Analytics pack (the local detector model and its server) as the renderer knows it: what is
 * installed, an archive found on this computer, a running install and the graphics card check.
 * Settings, Processing tools (`screens/settings/AnalyticsPack.tsx`) installs, updates and removes it.
 */
import type { AioBridge } from '@aio/schema';
import { useStore } from 'zustand';
import { createAnalyticsPackStore, type AnalyticsPack } from './analyticsPackStore';
import { bridge } from './shell';

export type { AnalyticsPack } from './analyticsPackStore';

const aio = window.aio as AioBridge | undefined;

/** The app's one store of the Analytics pack. */
export const analyticsPack = createAnalyticsPackStore(bridge, aio?.on.bind(aio));

export function useAnalyticsPack<T>(selector: (s: AnalyticsPack) => T): T {
  return useStore(analyticsPack, selector);
}
