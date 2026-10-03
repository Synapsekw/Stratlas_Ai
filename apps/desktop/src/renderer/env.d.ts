import type { AioBridge } from '@aio/schema';

declare global {
  interface Window {
    aio: AioBridge;
  }
}
