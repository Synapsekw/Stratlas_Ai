import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeOdmSystem, odmSmokeEnv } from './system';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-sys-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the smoke test environment', () => {
  it('drops NoDefaultCurrentDirectoryInExePath whatever its case and sets ODM_NONINTERACTIVE', () => {
    expect(
      odmSmokeEnv({ PATH: 'p', NODEFAULTCURRENTDIRECTORYINEXEPATH: '1', Gone: undefined }),
    ).toEqual({ PATH: 'p', ODM_NONINTERACTIVE: '1' });
  });

  it("drops the app's PYTHONHOME and PYTHONPATH whatever their case: ODM runs its own Python", () => {
    expect(
      odmSmokeEnv({ PATH: 'p', PYTHONHOME: 'C:\\Py', PythonPath: 'C:\\lib', PYTHONUTF8: '1' }),
    ).toEqual({ PATH: 'p', PYTHONUTF8: '1', ODM_NONINTERACTIVE: '1' });
  });
});

/** A run.bat stand-in: its output streams, and a close only when told. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

describe('the smoke test process', () => {
  it('answers a timeout when the killed process never closes, once, and lets go of its output', async () => {
    const child = fakeChild();
    const killed: (number | undefined)[] = [];
    const system = nodeOdmSystem(
      {},
      {
        smokeTimeoutMs: 20,
        closeGraceMs: 20,
        spawnSmoke: () => child as never,
        killTree: (pid) => killed.push(pid),
      },
    );
    const r = system.runSmoke('C:\\odm');
    child.stdout.write('compiling\n');
    expect(await r).toEqual({ code: 1, out: 'compiling\n', timedOut: true, stopped: false });
    expect(killed).toEqual([4242]);
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    child.emit('close', 0); // a late close changes nothing
  });

  it('a cancel kills the check at once', async () => {
    const child = fakeChild();
    const killed: (number | undefined)[] = [];
    const system = nodeOdmSystem(
      {},
      { closeGraceMs: 20, spawnSmoke: () => child as never, killTree: (pid) => killed.push(pid) },
    );
    const ctl = new AbortController();
    const r = system.runSmoke('C:\\odm', ctl.signal);
    ctl.abort();
    expect(killed).toEqual([4242]);
    child.emit('close', 1);
    expect(await r).toMatchObject({ code: 1, timedOut: false });
    // an abort before the start never spawns
    let spawned = false;
    const early = nodeOdmSystem(
      {},
      {
        spawnSmoke: () => {
          spawned = true;
          return fakeChild() as never;
        },
      },
    );
    expect(await early.runSmoke('C:\\odm', ctl.signal)).toMatchObject({ code: 1 });
    expect(spawned).toBe(false);
  });

  it('stopSmoke kills a check still running when the app quits', async () => {
    const child = fakeChild();
    const killed: (number | undefined)[] = [];
    const system = nodeOdmSystem(
      {},
      { closeGraceMs: 20, spawnSmoke: () => child as never, killTree: (pid) => killed.push(pid) },
    );
    system.stopSmoke(); // nothing running: nothing killed
    expect(killed).toEqual([]);
    const r = system.runSmoke('C:\\odm');
    system.stopSmoke();
    expect(killed).toEqual([4242]);
    // never closed: let go after the grace, and said to be stopped (the install takes it as a cancel)
    expect(await r).toMatchObject({ code: 1, timedOut: false, stopped: true });
    system.stopSmoke(); // finished: not killed again
    expect(killed).toEqual([4242]);
  });

  it('keeps only the last 64 KB of the output', async () => {
    const child = fakeChild();
    const system = nodeOdmSystem({}, { spawnSmoke: () => child as never });
    const r = system.runSmoke('C:\\odm');
    child.stdout.write('x'.repeat(100_000));
    child.stderr.write('usage: run');
    await new Promise((ok) => setImmediate(ok));
    child.emit('close', 0);
    const { out } = await r;
    expect(out.length).toBeLessThanOrEqual(64 * 1024);
    expect(out.endsWith('usage: run')).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')('the real smoke test', () => {
  it('runs run.bat --help through cmd.exe from the ODM folder', async () => {
    // like ODM's run.bat: calls winrun.bat by bare name, which needs the current folder searched
    await writeFile(join(dir, 'run.bat'), '@echo off\r\ncall winrun.bat %*\r\n');
    await writeFile(
      join(dir, 'winrun.bat'),
      '@echo off\r\necho usage: run [options] %1 %ODM_NONINTERACTIVE%\r\n',
    );
    const system = nodeOdmSystem({
      ...process.env,
      NoDefaultCurrentDirectoryInExePath: '1',
    });
    const r = await system.runSmoke(dir);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.out).toContain('usage: run [options] --help 1');
  });

  it('stops a run.bat that takes too long and says it ran out of time', async () => {
    await writeFile(
      join(dir, 'run.bat'),
      '@echo off\r\necho starting\r\nping -n 30 127.0.0.1 >nul\r\n',
    );
    const system = nodeOdmSystem(process.env, { smokeTimeoutMs: 1500 });
    const r = await system.runSmoke(dir);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('starting');
  }, 20_000);

  it('reg query answers nothing for a key with no ODM in it', async () => {
    const system = nodeOdmSystem(process.env);
    expect(await system.regQuery('HKCU\\Software\\QuadrionNoSuchKeyForTests')).toBe('');
  });
});
