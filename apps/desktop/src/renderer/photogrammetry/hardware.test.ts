import { describe, expect, it } from 'vitest';
import type { HardwareProbe } from '@aio/schema';
import { gpuLine, processingLine } from './hardware';

const probe = (over: Partial<HardwareProbe> = {}): HardwareProbe => ({
  platform: 'win32',
  arch: 'x64',
  cpu: { model: 'CPU', cores: 24 },
  memoryBytes: 64 * 2 ** 30,
  freeDiskBytes: 2 ** 40,
  gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'NVIDIA' }],
  cuda: true,
  processing: 'available',
  engine: { state: 'installed', version: '3.6.2', gpu: 'auto' },
  ...over,
});

describe('the wizard with ODM', () => {
  it('says to install the processing engine first', () => {
    const v = processingLine(probe({ processing: 'no-engine' }));
    expect(v).toMatchObject({
      ok: false,
      title: 'Install the processing engine first',
      fix: 'engine',
    });
  });

  it('names Windows only and the 0.8.0 tools', () => {
    expect(processingLine(probe({ processing: 'unsupported-platform' })).text).toContain(
      'Windows x64',
    );
    expect(processingLine(probe({ processing: 'no-pack' })).text).toContain('0.8.0');
  });

  it('says what the graphics card does', () => {
    expect(gpuLine(probe())).toBe('NVIDIA GeForce RTX 5070 Ti: used for processing');
    expect(gpuLine(probe({ engine: { state: 'installed', gpu: 'off' } }))).toBe(
      'NVIDIA GeForce RTX 5070 Ti: switched off in Settings; processing uses the CPU',
    );
    expect(gpuLine(probe({ cuda: false, gpus: [] }))).toBe(
      'No NVIDIA graphics card found; processing uses the CPU',
    );
  });
});
