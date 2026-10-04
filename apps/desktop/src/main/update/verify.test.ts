import { describe, expect, it } from 'vitest';
import { compareVersions, parseProbe, verifyInstaller, type Probe } from './verify';

/** Asymmetric matcher typed as unknown, so object literals stay type-safe. */
const matching = (re: RegExp): unknown => expect.stringMatching(re);

const signed: Probe = {
  status: 'Valid',
  signer: 'CN=Synapse Solutions FZ-LLC, O=Synapse Solutions FZ-LLC, C=AE',
  productVersion: '0.2.0',
  fileVersion: '0.2.0.0',
};

function deps(
  probe: Partial<Probe> = {},
  over: Partial<Parameters<typeof verifyInstaller>[1]> = {},
) {
  return {
    platform: 'win32',
    currentVersion: '0.1.0',
    publisher: 'Synapse Solutions',
    exists: () => Promise.resolve(true),
    probe: () => Promise.resolve({ ...signed, ...probe }),
    ...over,
  };
}

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', '1.9.0')).toBeGreaterThan(0);
  });
});

describe('verifyInstaller', () => {
  it('accepts a signed installer of a newer version', async () => {
    expect(await verifyInstaller('C:/d/Setup-0.2.0.exe', deps())).toEqual({
      ok: true,
      version: '0.2.0',
      current: '0.1.0',
      signer: signed.signer,
    });
  });

  it('refuses an unsigned installer', async () => {
    const r = await verifyInstaller('C:/d/Setup.exe', deps({ status: 'NotSigned', signer: '' }));
    expect(r).toMatchObject({ ok: false, error: matching(/not signed/i) });
  });

  it('refuses a tampered installer', async () => {
    const r = await verifyInstaller('C:/d/Setup.exe', deps({ status: 'HashMismatch' }));
    expect(r).toMatchObject({ ok: false, error: matching(/HashMismatch/) });
  });

  it('refuses an installer signed by someone else', async () => {
    const r = await verifyInstaller('C:/d/Setup.exe', deps({ signer: 'CN=Contoso Ltd' }));
    expect(r).toMatchObject({ ok: false, error: matching(/Contoso/) });
  });

  it('refuses the same or an older version', async () => {
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({ productVersion: '0.1.0' })),
    ).toMatchObject({ ok: false, error: matching(/already/) });
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({ productVersion: '0.0.9' })),
    ).toMatchObject({ ok: false, error: matching(/older/) });
  });

  it('falls back to the file version and refuses a file without one', async () => {
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({ productVersion: '', fileVersion: '0.3.0.0' })),
    ).toMatchObject({ ok: true, version: '0.3.0' });
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({ productVersion: '', fileVersion: '' })),
    ).toMatchObject({ ok: false, error: matching(/version/) });
  });

  it('only takes .exe installers that exist', async () => {
    expect(await verifyInstaller('C:/d/readme.txt', deps())).toMatchObject({
      ok: false,
      error: matching(/\.exe/),
    });
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({}, { exists: () => Promise.resolve(false) })),
    ).toMatchObject({ ok: false, error: matching(/not found/) });
  });

  it('explains that file updates are Windows only for now', async () => {
    expect(
      await verifyInstaller('/Users/me/app.exe', deps({}, { platform: 'darwin' })),
    ).toMatchObject({ ok: false, error: matching(/Windows/) });
  });

  it('reports a probe that fails', async () => {
    expect(
      await verifyInstaller(
        'C:/d/Setup.exe',
        deps({}, { probe: () => Promise.reject(new Error('powershell missing')) }),
      ),
    ).toMatchObject({ ok: false, error: matching(/powershell missing/) });
  });
});

describe('parseProbe', () => {
  it('reads the PowerShell JSON answer', () => {
    expect(
      parseProbe('{"status":"Valid","signer":"CN=X","product":"1.2.3","file":"1.2.3.0"}'),
    ).toEqual({ status: 'Valid', signer: 'CN=X', productVersion: '1.2.3', fileVersion: '1.2.3.0' });
    expect(parseProbe('{"status":"NotSigned","signer":null,"product":null,"file":null}')).toEqual({
      status: 'NotSigned',
      signer: '',
      productVersion: '',
      fileVersion: '',
    });
  });
});
