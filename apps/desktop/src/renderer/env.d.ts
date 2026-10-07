/// <reference types="vite/client" />
import type { AioBridge } from '@aio/schema';

declare global {
  interface Window {
    aio: AioBridge;
  }

  /** Build stamp injected by electron.vite.config.ts (`define`); read it through ./buildStamp. */
  const __QUADRION_BUILD__: { time: string; commit: string; version: string };
}
