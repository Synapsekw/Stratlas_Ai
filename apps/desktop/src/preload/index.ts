import type { AioBridge } from '@aio/schema';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Only the declared channels exist; main validates every request against @aio/schema.
const bridge: AioBridge = {
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (event, listener) => {
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.off(event, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('aio', bridge);
