import fs from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from './fsutil';
import {
  assertWritable,
  DEFAULT_REAL_DATA_ROOT,
  installRealDataGuard,
  isUnderRealData,
  isWithin,
  realDataRefusals,
  realDataRootFromEnv,
  RealDataWriteRefusedError,
  uninstallRealDataGuard,
} from './realDataGuard';

let base = '';
let real = '';
let copy = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-guard-'));
  // a fake "real data root" with one project, and a test copy beside it
  real = join(base, 'Real Data');
  copy = join(base, 'copy');
  await mkdir(join(real, 'projects', 'p'), { recursive: true });
  await mkdir(join(copy, 'projects', 'p'), { recursive: true });
  await writeFile(join(real, 'projects', 'p', 'issues.json'), '{"issues":[]}\n');
  realDataRefusals().splice(0);
});

afterEach(async () => {
  uninstallRealDataGuard();
  realDataRefusals().splice(0);
  await rm(base, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  STRATLAS_E2E: '1',
  STRATLAS_REAL_DATA_ROOT: real,
  ...extra,
});

describe('realDataRootFromEnv', () => {
  it('is off outside e2e runs', () => {
    expect(realDataRootFromEnv({})).toBeNull();
    expect(realDataRootFromEnv({ STRATLAS_REAL_DATA_ROOT: 'X:\\data' })).toBeNull();
  });
  it('protects STRATLAS_REAL_DATA_ROOT, else the founder default', () => {
    expect(realDataRootFromEnv({ STRATLAS_E2E: '1', STRATLAS_REAL_DATA_ROOT: real })).toBe(real);
    expect(realDataRootFromEnv({ STRATLAS_E2E: '1' })).toMatch(/Stratlas Data$/);
    expect(DEFAULT_REAL_DATA_ROOT).toBe('E:\\Stratlas Data');
  });
});

describe('isWithin and isUnderRealData', () => {
  it('matches the root and below it, not a sibling with the same prefix', () => {
    expect(isWithin(real, real)).toBe(true);
    expect(isWithin(real, join(real, 'projects', 'p', 'x.json'))).toBe(true);
    expect(isWithin(real, join(real, '..', 'copy'))).toBe(false);
    expect(isWithin(real, `${real} 2`)).toBe(false);
  });
  it.runIf(process.platform === 'win32')('ignores case on Windows', () => {
    expect(isWithin(real, join(real.toUpperCase(), 'projects'))).toBe(true);
  });
  it('sees through `..` and a link into the real root', () => {
    expect(isUnderRealData(join(copy, '..', 'Real Data', 'projects'), real)).toBe(true);
    const junction = join(copy, 'into-real');
    // a directory junction needs no privilege on Windows; a symlink elsewhere
    fs.symlinkSync(join(real, 'projects'), junction, 'junction');
    expect(isUnderRealData(join(junction, 'p', 'issues.json'), real)).toBe(true);
    expect(isUnderRealData(join(junction, 'p', 'new.json'), real)).toBe(true);
    expect(isUnderRealData(join(copy, 'projects', 'p', 'issues.json'), real)).toBe(false);
  });
});

describe('the guard refuses writes into a fake real data root', () => {
  it('does nothing when it is not installed', async () => {
    expect(installRealDataGuard({ STRATLAS_REAL_DATA_ROOT: real })).toBeNull();
    const file = join(real, 'projects', 'p', 'issues.json');
    await writeJsonAtomic(file, { issues: [1] });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ issues: [1] });
  });

  it('refuses writeJsonAtomic under the root, loudly, and leaves the file as it was', async () => {
    expect(installRealDataGuard(env())).toBe(real);
    const file = join(real, 'projects', 'p', 'issues.json');
    const before = await readFile(file, 'utf8');
    const err: unknown = await writeJsonAtomic(file, { issues: ['F79'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealDataWriteRefusedError);
    expect((err as RealDataWriteRefusedError).code).toBe('real-data-write-refused');
    expect(String(err)).toContain('Tests must run on a copy');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(join(real, 'projects', 'p'))).toEqual(['issues.json']);
    expect(realDataRefusals()).toHaveLength(1);
    expect(realDataRefusals()[0]).toContain('writeJsonAtomic');
  });

  it('allows the same write in the copy', async () => {
    installRealDataGuard(env());
    const file = join(copy, 'projects', 'p', 'issues.json');
    await writeJsonAtomic(file, { issues: ['F01'] }, { backup: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ issues: ['F01'] });
    expect(realDataRefusals()).toEqual([]);
  });

  it('refuses any fs write of main: promises, callbacks and Sync forms', async () => {
    installRealDataGuard(env());
    const dir = join(real, 'projects', 'p');
    const target = join(dir, 'detections', 'review.json');
    await expect(mkdir(join(dir, 'detections'))).rejects.toThrow(RealDataWriteRefusedError);
    await expect(writeFile(join(dir, 'x.json'), '{}')).rejects.toThrow(/refused fs\.writeFile/);
    await expect(appendFile(join(dir, 'issues.json'), 'x')).rejects.toThrow(/real data root/);
    await expect(rm(join(dir, 'issues.json'))).rejects.toThrow(RealDataWriteRefusedError);
    expect(() => {
      fs.writeFileSync(target, '{}');
    }).toThrow(RealDataWriteRefusedError);
    expect(() => {
      fs.renameSync(join(dir, 'issues.json'), join(copy, 'moved.json'));
    }).toThrow(RealDataWriteRefusedError);
    expect(() => {
      fs.openSync(join(dir, 'issues.json'), 'r+');
    }).toThrow(RealDataWriteRefusedError);
    expect(() => {
      fs.createWriteStream(join(dir, 'log.txt'));
    }).toThrow(RealDataWriteRefusedError);
    expect(() => {
      fs.unlink(join(dir, 'issues.json'), () => undefined);
    }).toThrow(RealDataWriteRefusedError);
    // reading stays allowed
    expect(fs.readFileSync(join(dir, 'issues.json'), 'utf8')).toContain('issues');
    fs.closeSync(fs.openSync(join(dir, 'issues.json'), 'r'));
    expect(fs.readdirSync(dir)).toEqual(['issues.json']);
    expect(realDataRefusals().length).toBeGreaterThanOrEqual(9);
  });

  it('refuses a write in place to a hard-linked file of a copy, but not its atomic replacement', async () => {
    const big = join(real, 'projects', 'p', 'photo.jpg');
    await writeFile(big, 'real bytes');
    const linked = join(copy, 'projects', 'p', 'photo.jpg');
    await link(big, linked);
    installRealDataGuard(env());
    await expect(writeFile(linked, 'changed')).rejects.toThrow(/more than one hard link/);
    expect(() => {
      fs.truncateSync(linked);
    }).toThrow(RealDataWriteRefusedError);
    expect(await readFile(big, 'utf8')).toBe('real bytes');
    // temp file and rename: only the copy's link is replaced
    await writeFile(`${linked}.tmp`, 'new bytes');
    fs.renameSync(`${linked}.tmp`, linked);
    expect(await readFile(linked, 'utf8')).toBe('new bytes');
    expect(await readFile(big, 'utf8')).toBe('real bytes');
  });

  it('assertWritable is the same check for code that writes another way', () => {
    installRealDataGuard(env());
    expect(() => {
      assertWritable(join(real, 'journal', 'ops', 'x.jsonl'), 'journal append');
    }).toThrow(/refused journal append/);
    expect(() => {
      assertWritable(join(copy, 'journal', 'ops', 'x.jsonl'), 'journal append');
    }).not.toThrow();
  });

  it.runIf(process.platform === 'win32')(
    'keeps protecting the founder default when the env names another root',
    () => {
      installRealDataGuard(env());
      expect(() => {
        assertWritable(join(DEFAULT_REAL_DATA_ROOT, 'projects', 'ebsm', 'issues.json'), 'test');
      }).toThrow(RealDataWriteRefusedError);
    },
  );

  it('puts fs back when uninstalled', async () => {
    installRealDataGuard(env());
    uninstallRealDataGuard();
    await writeFile(join(real, 'projects', 'p', 'after.json'), '{}');
    expect(fs.existsSync(join(real, 'projects', 'p', 'after.json'))).toBe(true);
  });
});
