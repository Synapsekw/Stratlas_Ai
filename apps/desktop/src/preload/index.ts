import { envVar } from '@aio/brand/env';
import type { AioBridge, IpcChannel, IpcEventName } from '@aio/schema';
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { launchGateMode } from './launchGate';

// Only the declared channels exist; main validates every request against @aio/schema. The lists
// are type-checked against the contract so a new channel cannot be forgotten here. (No runtime
// import of @aio/schema: the sandboxed preload stays free of zod.)
const CHANNELS = {
  'app:getInfo': true,
  'library:list': true,
  'app:setupStatus': true,
  'library:add': true,
  'project:open': true,
  'project:writeIssues': true,
  'project:readVolumes': true,
  'project:writeBoundaries': true,
  'project:writeCentreline': true,
  'packs:list': true,
  'settings:get': true,
  'settings:set': true,
  'ai:setKey': true,
  'ai:hasKey': true,
  'ai:testConnection': true,
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
  'ai:detect': true,
  'detections:read': true,
  'detections:write': true,
  'detections:maskAssistStatus': true,
  'detections:maskAssist': true,
  'dialog:openFolder': true,
  'dialog:saveFile': true,
  'dialog:openFile': true,
  'app:takeOpenPath': true,
  'package:plan': true,
  'package:export': true,
  'package:cancel': true,
  'package:extract': true,
  'export:run': true,
  'export:cancel': true,
  'report:list': true,
  'report:readNarrative': true,
  'report:writeNarrative': true,
  'ai:draftText': true,
  'branding:setLogo': true,
  'branding:clearLogo': true,
  'thumbs:put': true,
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
  'app:exportDiagnostics': true,
  'app:crashNotice': true,
  'app:dismissCrashNotice': true,
  'update:verifyFile': true,
  'update:installFile': true,
  'update:check': true,
  'update:downloadAndInstall': true,
  'update:notes': true,
  'update:status': true,
  'update:rollback': true,
  'app:rendererReady': true,
  'jobs:start': true,
  'jobs:list': true,
  'jobs:cancel': true,
  'jobs:log': true,
  'jobs:open': true,
  'dialog:openFiles': true,
  'builder:templates': true,
  'builder:createProject': true,
  'builder:photoGps': true,
  'builder:import': true,
  'builder:altitudePlan': true,
  'builder:updateLayers': true,
  // M8
  'change:list': true,
  'change:read': true,
  'change:write': true,
  'change:compute': true,
  'change:cancel': true,
  'model:list': true,
  'model:read': true,
  'model:write': true,
  'model:build': true,
  'ai:setCloudDrawings': true,
  'inference:models': true,
  'inference:importModel': true,
  'inference:removeModel': true,
  'inference:run': true,
  'inference:cancel': true,
  'ai:localModels': true,
  'ai:localProbe': true,
  // M9
  'identity:get': true,
  'identity:set': true,
  'identity:exportCard': true,
  'identity:importCard': true,
  'members:list': true,
  'members:add': true,
  'members:setRole': true,
  'members:remove': true,
  'members:revokeDevice': true,
  'journal:history': true,
  'journal:verify': true,
  'journal:redact': true,
  'journal:setEnabled': true,
  'audit:export': true,
  'collab:read': true,
  'collab:comment': true,
  'collab:editComment': true,
  'collab:deleteComment': true,
  'collab:redactComment': true,
  'collab:assign': true,
  'collab:approve': true,
  'collab:withdraw': true,
  'collab:policy': true,
  'team:share': true,
  'team:status': true,
  'team:leave': true,
  'sync:now': true,
  'sync:conflicts': true,
  'sync:resolve': true,
  'sync:quarantine': true,
  'sync:release': true,
  'team:hubProjects': true,
  'exchange:peers': true,
  'exchange:plan': true,
  'exchange:export': true,
  'exchange:preview': true,
  'exchange:import': true,
  'exchange:reply': true,
  'blobs:status': true,
  'blobs:fetch': true,
  'blobs:cancel': true,
  'blobs:policy': true,
  'blobs:index': true,
  'blobs:free': true,
  'server:enrol': true,
  'server:list': true,
  'server:check': true,
  'server:forget': true,
} as const satisfies Record<IpcChannel, true>;

const EVENTS = {
  'ai:event': true,
  'package:progress': true,
  'app:openPath': true,
  'app:menu': true,
  'update:progress': true,
  'app:reportProblem': true,
  'export:progress': true,
  'packs:job': true,
  'jobs:event': true,
  'builder:progress': true,
  'change:progress': true,
  'inference:progress': true,
  // M9
  'journal:changed': true,
  'sync:progress': true,
  'exchange:progress': true,
  'blobs:progress': true,
  'sync:notice': true,
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
  // Dropped files: the sandboxed renderer has no File.path; main still validates every path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  // Graphics tier detection reads the installed memory before the first frame, so synchronously.
  // QUADRION_SYSTEM_MEMORY_GB pretends a smaller machine (low-end simulation, tests).
  systemMemory: () => {
    try {
      const info = process.getSystemMemoryInfo(); // kilobytes
      const simulated = Number(envVar(process.env, 'SYSTEM_MEMORY_GB'));
      const total = simulated > 0 ? simulated * 2 ** 30 : info.total * 1024;
      return { total, free: Math.min(total, info.free * 1024) };
    } catch {
      return null;
    }
  },
  // The launch screen decides before its first frame, so synchronously from the environment.
  launchGate: () => launchGateMode(process.env),
  processMemory: async () => {
    try {
      const m = await process.getProcessMemoryInfo(); // kilobytes
      return { residentSet: m.residentSet * 1024, private: m.private * 1024 };
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld('aio', bridge);
