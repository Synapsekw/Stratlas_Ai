import { describe, expect, it } from 'vitest';
import { compareVersions, parseProbe, probeFailure, verifyInstaller, type Probe } from './verify';

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

  it('looks for the company in the CN or O only, not anywhere in the subject', async () => {
    const r = await verifyInstaller(
      'C:/d/Setup.exe',
      deps({ signer: 'CN=Mallory, OU=Synapse Solutions fans, C=AE' }),
    );
    expect(r).toMatchObject({ ok: false, error: matching(/Mallory/) });
  });

  it('requires the exact identity from brand.json when one is configured', async () => {
    const exact = { signingIdentity: 'Synapse Solutions FZ-LLC' };
    expect(await verifyInstaller('C:/d/Setup.exe', deps({}, exact))).toMatchObject({ ok: true });
    expect(
      await verifyInstaller(
        'C:/d/Setup.exe',
        deps({ signer: 'CN=Synapse Solutions FZ-LLC Imitation, C=AE' }, exact),
      ),
    ).toMatchObject({ ok: false, error: matching(/not by Synapse Solutions FZ-LLC/) });
    expect(
      await verifyInstaller(
        'C:/d/Setup.exe',
        deps({ signer: 'CN=Build 7, O="Synapse Solutions FZ-LLC", C=AE' }, exact),
      ),
    ).toMatchObject({ ok: true });
  });

  it('requires the version the update feed announced', async () => {
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({}, { expectedVersion: '0.3.0' })),
    ).toMatchObject({ ok: false, error: matching(/holds version 0.2.0, not 0.3.0/) });
    expect(
      await verifyInstaller('C:/d/Setup.exe', deps({}, { expectedVersion: '0.2.0' })),
    ).toMatchObject({ ok: true });
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

describe('probeFailure', () => {
  // what Node reports of a failed execFile: "Command failed: " and the whole command line
  const COMMAND =
    'Command failed: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' +
    '$p = $env:AIO_INSTALLER; $s = Get-AuthenticodeSignature -LiteralPath $p';
  const timedOut = { message: COMMAND, killed: true, signal: 'SIGTERM', code: null };
  const plain = (text: string) => {
    expect(text).not.toMatch(/Command failed|powershell\.exe|-NoProfile|-Command|\$env:|\$p/);
    return text;
  };

  it('says in a plain sentence that Windows did not answer in time', () => {
    expect(plain(probeFailure(timedOut))).toBe(
      'Windows did not answer within 30 seconds. Try again.',
    );
  });

  it('reads as one sentence after "The installer could not be checked"', async () => {
    const probe = () => Promise.reject(new Error(probeFailure(timedOut)));
    expect(await verifyInstaller('C:/d/Setup.exe', deps({}, { probe }))).toEqual({
      ok: false,
      error:
        'The installer could not be checked: Windows did not answer within 30 seconds. Try again.',
    });
  });

  it('keeps what PowerShell said of an error, without the command line', () => {
    const stderr = [
      'Get-AuthenticodeSignature : Cannot find path C:\\d\\Setup.exe because it does not exist.',
      'At line:1 char:31',
      '+ $p = $env:AIO_INSTALLER; $s = Get-AuthenticodeSignature -LiteralPath $p',
    ].join('\r\n');
    const reason = probeFailure({ message: `${COMMAND}\n${stderr}`, code: 1 }, stderr);
    expect(plain(reason)).toMatch(/Cannot find path C:\\d\\Setup\.exe/);
    expect(reason).toMatch(/code 1/);
  });

  it('names the exit code when PowerShell said nothing readable', () => {
    const script = 'At line:1 char:5\n+ $p = $env:AIO_INSTALLER; $s = Get-AuthenticodeSignature';
    expect(plain(probeFailure({ message: COMMAND, code: 5 }, ''))).toMatch(/code 5/);
    expect(plain(probeFailure({ message: COMMAND, code: 5 }, script))).toMatch(/code 5/);
  });

  it('says when PowerShell is missing or was stopped', () => {
    expect(probeFailure({ message: 'spawn powershell.exe ENOENT', code: 'ENOENT' })).toBe(
      'Windows PowerShell was not found on this computer.',
    );
    expect(plain(probeFailure({ message: COMMAND, signal: 'SIGKILL', code: null }))).toMatch(
      /stopped before it answered/,
    );
  });

  it('never passes on a message that holds the command line', () => {
    expect(plain(probeFailure({ message: COMMAND }))).toMatch(/could not be run/);
    expect(probeFailure({ message: 'Access is denied.' })).toBe('Access is denied.');
  });
});
