import type { AioBridge, IpcChannel, IpcEventName } from '@aio/schema';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Only the declared channels exist; main validates every request against @aio/schema. The lists
// are type-checked against the contract so a new channel cannot be forgotten here. (No runtime
// import of @aio/schema: the sandboxed preload stays free of zod.)
const CHANNELS = {
  'app:getInfo': true,
  'library:list': true,
  'library:add': true,
  'project:open': true,
  'project:writeIssues': true,
  'project:readVolumes': true,
  'project:writeBoundaries': true,
  'packs:list': true,
  'settings:get': true,
  'settings:set': true,
  'ai:setKey': true,
  'ai:hasKey': true,
  'ai:send': true,
  'ai:toolResult': true,
  'ai:cancel': true,
  'ai:status': true,
  'ai:project': true,
  'ai:setConsent': true,
  'ai:usage': true,
  'ai:listConversations': true,
  'ai:loadConversation': true,
  'ai:saveConversation': true,
  'dialog:openFolder': true,
  'dialog:saveFile': true,
  'dialog:openFile': true,
  'app:takeOpenPath': true,
  'package:plan': true,
  'package:export': true,
  'package:cancel': true,
  'export:run': true,
  'export:cancel': true,
  'report:list': true,
  'packs:download': true,
  'packs:jobs': true,
  'packs:cancel': true,
  'packs:resume': true,
  'packs:dismiss': true,
  'packs:remove': true,
  'packs:import': true,
  'app:about': true,
  'app:licenses': true,
  'app:exportLogs': true,
  'app:showFolder': true,
  'update:verifyFile': true,
  'update:installFile': true,
  'update:check': true,
  'update:downloadAndInstall': true,
  'jobs:start': true,
  'jobs:list': true,
  'jobs:cancel': true,
  'jobs:log': true,
  'jobs:open': true,
} as const satisfies Record<IpcChannel, true>;

const EVENTS = {
  'ai:event': true,
  'package:progress': true,
  'app:openPath': true,
  'export:progress': true,
  'packs:job': true,
  'jobs:event': true,
} as const satisfies Record<IpcEventName, true>;

const known = <K extends string>(table: Record<K, true>, key: string): key is K =>
  Object.prototype.hasOwnProperty.call(table, key);

const bridge: AioBridge = {
  invoke: (channel, request) => {
    if (!known(CHANNELS, channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, request);
  },
  on: (event, listener) => {
    if (!known(EVENTS, event)) throw new Error(`Unknown IPC event: ${String(event)}`);
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
