import type { DetectorModelInfo } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  localAgentSummary,
  localAiSection,
  modelCardSummary,
  packageVersionOf,
  runtimeSummary,
  type LocalAiSources,
} from './localAi';
import { OTHER_MACHINE, redactSettings } from './redact';

const KEY = `sk-ant-api03-${'C9'.repeat(24)}`;
const SHA = 'a'.repeat(64);

const model = (over: Partial<DetectorModelInfo['card']> = {}): DetectorModelInfo => ({
  id: 'marker-test-detector-1.0.0',
  where: 'user',
  sizeBytes: 12_345,
  card: {
    schema: 'aio.detector/1',
    name: 'Marker test detector',
    version: '1.0.0',
    layout: 'yolo-v8',
    input: { width: 320, height: 320 },
    classes: ['marker', 'cyan-marker'],
    licence: 'MIT',
    source: 'Stratlas test fixture',
    sha256: SHA,
    author: 'Jane Person',
    description: 'Trained on C:\\Users\\jane\\photos',
    ...over,
  },
});

const offlineRoutes = ['chat', 'vision', 'report', 'extract', 'build'].map((task) => ({
  task,
  provider: 'local',
  model: 'qwen3',
}));

function sources(over: Partial<LocalAiSources> = {}): LocalAiSources {
  return {
    settings: {
      routes: offlineRoutes,
      localModel: {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3',
        kind: 'ollama',
        capabilities: { tools: true, vision: false },
      },
      inference: {
        provider: 'auto',
        modelsDir: 'C:\\Users\\jane\\Stratlas models',
        memoryCapMb: 4096,
      },
    },
    runtime: {
      running: true,
      probe: { available: true, provider: 'dml', version: '1.30.0', backends: ['cpu', 'dml'] },
    },
    packageVersion: '1.30.0',
    models: () => Promise.resolve([model()]),
    server: { kind: 'ollama', version: '0.12.3', loopback: true, at: '2026-10-06T10:00:00.000Z' },
    ...over,
  };
}

describe('local AI diagnostics: onnx runtime', () => {
  it('says "not started" and gives the shipped package when nothing ran the runtime', () => {
    expect(runtimeSummary(null, '1.30.0', undefined)).toEqual({
      package: 'onnxruntime-node',
      packageVersion: '1.30.0',
      providerSetting: 'auto',
      state: 'not started',
    });
    expect(runtimeSummary({ running: true, probe: null }, null, { provider: 'cpu' })).toEqual({
      package: 'onnxruntime-node',
      packageVersion: 'not found',
      providerSetting: 'cpu',
      state: 'started, not probed yet',
    });
  });

  it('gives the version and the provider in use and available from the last probe', () => {
    const r = runtimeSummary(
      {
        running: false,
        probe: { available: true, provider: 'dml', version: '1.30.0', backends: ['cpu', 'dml'] },
      },
      '1.30.0',
      { provider: 'auto', memoryCapMb: 2048 },
    );
    expect(r).toMatchObject({
      state: 'stopped (last probe of this run below)',
      available: true,
      version: '1.30.0',
      provider: 'dml',
      providerName: 'DirectML (graphics card)',
      backends: ['cpu', 'dml'],
      memoryCapMb: 2048,
    });
  });

  it('scrubs the user name and keys out of a load problem', () => {
    const r = runtimeSummary(
      {
        running: true,
        probe: {
          available: false,
          problem: `The ONNX runtime could not be loaded: C:\\Users\\jane\\AppData\\x.node ${KEY}`,
        },
      },
      '1.30.0',
      undefined,
    );
    expect(r.available).toBe(false);
    expect(String(r.problem)).toContain('C:\\Users\\[user]\\AppData');
    expect(String(r.problem)).not.toContain('jane');
    expect(String(r.problem)).not.toContain(KEY);
  });

  it('reads the shipped onnxruntime-node version without loading it', () => {
    expect(packageVersionOf('onnxruntime-node')).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageVersionOf('no-such-package-here')).toBeNull();
  });
});

describe('local AI diagnostics: detector model cards', () => {
  it('keeps the card facts and leaves out author, description and paths', () => {
    const r = modelCardSummary(model({ source: 'https://example.org/weights, /home/jane/w' }));
    expect(r).toEqual({
      id: 'marker-test-detector-1.0.0',
      where: 'imported',
      name: 'Marker test detector',
      version: '1.0.0',
      layout: 'yolo-v8',
      input: '320x320',
      classes: ['marker', 'cyan-marker'],
      licence: 'MIT',
      source: 'https://example.org/weights, /home/[user]/w',
      sha256: SHA,
      sizeBytes: 12_345,
    });
    expect(JSON.stringify(r)).not.toContain('jane');
    expect(JSON.stringify(r)).not.toContain('Jane');
  });

  it('lists the first 100 classes of a big model and counts them all', () => {
    const classes = Array.from({ length: 150 }, (_, i) => `c${String(i)}`);
    const r = modelCardSummary({ ...model({ classes }), where: 'pack' });
    expect(r.where).toBe('pipeline pack');
    expect((r.classes as string[]).length).toBe(100);
    expect(r.classCount).toBe(150);
  });
});

describe('local AI diagnostics: local agent server', () => {
  it('gives kind, version and the offline agent switch for a server on this machine', () => {
    const safe = redactSettings(sources().settings);
    expect(localAgentSummary(safe, sources().server)).toEqual({
      enabled: true,
      kind: 'ollama',
      serverVersion: '0.12.3',
      serverOnThisMachine: true,
      probedAt: '2026-10-06T10:00:00.000Z',
      address: 'http://localhost:11434/v1',
      model: 'qwen3',
      capabilities: { tools: true, vision: false },
      offlineAgent: true,
    });
  });

  it('never gives the address of a server on another machine', () => {
    const settings = {
      routes: [{ task: 'chat', provider: 'anthropic', model: 'claude' }],
      localModel: {
        enabled: true,
        baseUrl: 'http://gpu-box.office.lan:8080/v1',
        model: 'm',
        kind: 'openai-compatible',
      },
    };
    const r = localAgentSummary(redactSettings(settings), {
      kind: 'openai-compatible',
      loopback: false,
      at: '2026-10-06T10:00:00.000Z',
    });
    expect(r).toMatchObject({
      kind: 'openai-compatible',
      serverVersion: 'not reported by this kind of server',
      serverOnThisMachine: false,
      address: OTHER_MACHINE,
      offlineAgent: false,
    });
    expect(JSON.stringify(r)).not.toContain('gpu-box');
  });

  it('says when no server was probed and the local model is off', () => {
    expect(localAgentSummary(redactSettings({}), null)).toEqual({
      enabled: false,
      kind: 'not found yet',
      serverVersion: 'not probed in this run',
      offlineAgent: false,
    });
  });
});

describe('local AI diagnostics: the section', () => {
  it('puts runtime, cards and agent together; the models folder by name only', async () => {
    const r = await localAiSection(sources());
    expect(Object.keys(r)).toEqual(['onnxRuntime', 'detectorModels', 'modelsFolder', 'localAgent']);
    expect(r.modelsFolder).toBe('Stratlas models');
    expect(r.detectorModels).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('jane');
  });

  it('still answers when the model folders cannot be read', async () => {
    const r = await localAiSection(
      sources({ models: () => Promise.reject(new Error('EACCES /home/jane/models')) }),
    );
    expect(r.detectorModels).toEqual({ error: 'EACCES /home/[user]/models' });
    expect(r.onnxRuntime).toMatchObject({ available: true });
  });
});
