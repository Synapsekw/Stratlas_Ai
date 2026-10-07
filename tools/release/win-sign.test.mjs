// Dry run of the Windows signing route choice and the sign hook: nothing is signed, nothing runs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  builderEnv,
  describeWindowsRoute,
  unsignedBuildEnv,
  windowsRouteEnv,
  windowsSigning,
} from './brand-config.mjs';
import { describeInvocation, normaliseThumbprint, signInvocation } from './win-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

// Fake values only.
const azure = {
  AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGN_ACCOUNT: 'acct',
  AZURE_SIGN_PROFILE: 'profile',
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
};
const thumbprint = '0123456789abcdef0123456789abcdef01234567';
const keylocker = {
  SM_HOST: 'https://clientauth.one.digicert.com',
  SM_API_KEY: 'fake-api-key',
  SM_CLIENT_CERT_FILE_B64: 'ZmFrZQ==',
  SM_CLIENT_CERT_PASSWORD: 'fake-password',
  SM_CODE_SIGNING_CERT_SHA1_HASH: thumbprint,
};
const pfx = { WIN_CSC_LINK: 'ZmFrZQ==', WIN_CSC_KEY_PASSWORD: 'pw' };
const command = { WIN_SIGN_COMMAND: 'CodeSignTool sign -input_file_path={file} -override' };

describe('Windows route order', () => {
  it('is Azure, then DigiCert KeyLocker, then the .pfx, then WIN_SIGN_COMMAND', () => {
    const all = { ...azure, ...keylocker, ...pfx, ...command };
    expect(windowsSigning(all).mode).toBe('azure');
    expect(windowsSigning({ ...keylocker, ...pfx, ...command }).mode).toBe('keylocker');
    expect(windowsSigning({ ...pfx, ...command }).mode).toBe('pfx');
    expect(windowsSigning(command).mode).toBe('command');
    expect(windowsSigning({}).mode).toBe('unsigned');
  });

  it('takes KeyLocker with the client certificate as base64 or as a decoded file', () => {
    expect(windowsSigning(keylocker).mode).toBe('keylocker');
    const decoded = {
      ...keylocker,
      SM_CLIENT_CERT_FILE_B64: '',
      SM_CLIENT_CERT_FILE: 'C:/t/c.p12',
    };
    expect(windowsSigning(decoded).mode).toBe('keylocker');
  });

  it('skips KeyLocker when any of its values is missing or empty', () => {
    for (const key of Object.keys(keylocker)) {
      expect(windowsSigning({ ...keylocker, [key]: '' }).mode, key).toBe('unsigned');
    }
  });

  it('points electron-builder at the hook for KeyLocker and the command, not for Azure or .pfx', () => {
    expect(windowsSigning(keylocker).win.signtoolOptions.sign).toMatch(/win-sign\.mjs$/);
    expect(windowsSigning(command).win.signtoolOptions.sign).toMatch(/win-sign\.mjs$/);
    expect(windowsSigning(pfx).win).toEqual({});
    expect(windowsSigning(azure).win.signtoolOptions).toBeUndefined();
  });

  it('logs the route by name, never a value', () => {
    const line = describeWindowsRoute(windowsSigning(keylocker).mode);
    expect(line).toMatch(/^Windows signing route: keylocker \(DigiCert KeyLocker/);
    for (const value of Object.values(keylocker)) expect(line).not.toContain(value);
  });
});

describe('exactly one route reaches electron-builder', () => {
  it('drops the other routes’ variables for a Windows build', () => {
    const env = builderEnv({ ...keylocker, ...pfx, ...command, PATH: '/bin' }, ['--win']);
    expect(Object.keys(env).sort()).toEqual([...Object.keys(keylocker), 'PATH'].sort());
    expect(windowsRouteEnv({ ...azure, ...pfx }, 'azure').WIN_CSC_LINK).toBeUndefined();
  });

  it('leaves a macOS build alone', () => {
    const env = builderEnv({ CSC_LINK: 'p12', ...keylocker }, ['--mac']);
    expect(env.CSC_LINK).toBe('p12');
  });

  it('drops everything with QUADRION_NO_SIGNING=1', () => {
    const env = builderEnv(
      { QUADRION_NO_SIGNING: '1', ...azure, ...keylocker, ...pfx, ...command, CSC_LINK: 'p12' },
      ['--win'],
    );
    expect(windowsSigning(env).mode).toBe('unsigned');
    expect(Object.keys(env)).toEqual(['QUADRION_NO_SIGNING']);
    expect(unsignedBuildEnv({ APPLE_ID: 'a', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('drops empty CI values', () => {
    expect(builderEnv({ WIN_CSC_LINK: '', PATH: '/bin' }, ['--win'])).toEqual({ PATH: '/bin' });
  });
});

describe('sign hook (dry run)', () => {
  it('signs through signtool /sha1 with SHA-256 and the DigiCert timestamp for KeyLocker', () => {
    const inv = signInvocation(
      { ...keylocker, SIGNTOOL_PATH: 'C:/sdk/signtool.exe' },
      'C:/out/a.exe',
    );
    expect(inv).toEqual({
      route: 'keylocker',
      exe: 'C:/sdk/signtool.exe',
      args: [
        'sign',
        '/sha1',
        thumbprint.toUpperCase(),
        '/tr',
        'http://timestamp.digicert.com',
        '/td',
        'SHA256',
        '/fd',
        'SHA256',
        'C:/out/a.exe',
      ],
    });
    const line = describeInvocation(inv);
    expect(line).not.toContain(thumbprint.toUpperCase());
    expect(line).toContain('/sha1 ***');
  });

  it('fills the WIN_SIGN_COMMAND template', () => {
    expect(signInvocation(command, 'C:/out/a b.exe')).toEqual({
      route: 'command',
      shell: 'CodeSignTool sign -input_file_path="C:/out/a b.exe" -override',
    });
    expect(() => signInvocation({ WIN_SIGN_COMMAND: 'sign' }, 'a.exe')).toThrow(/\{file\}/);
  });

  it('refuses routes that electron-builder signs itself, and an unsigned build', () => {
    expect(() => signInvocation(pfx, 'a.exe')).toThrow(/pfx/);
    expect(() => signInvocation({}, 'a.exe')).toThrow(/unsigned/);
  });

  it('normalises the thumbprint and rejects a malformed one without echoing it', () => {
    expect(normaliseThumbprint('01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67')).toBe(
      thumbprint.toUpperCase(),
    );
    expect(() => normaliseThumbprint('not-a-hash')).toThrow(/^((?!not-a-hash).)*$/);
  });

  it('prints the route from the command line without signing', () => {
    const env = { ...process.env, ...keylocker, QUADRION_NO_SIGNING: '' };
    const out = execFileSync(process.execPath, [join(here, 'win-sign.mjs'), '--dry-run', 'a.exe'], {
      env,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(
      'keylocker: signtool sign /sha1 *** /tr http://timestamp.digicert.com /td SHA256 /fd SHA256 a.exe',
    );
    const route = execFileSync(process.execPath, [join(here, 'brand-config.mjs'), '--route'], {
      env: { ...env, QUADRION_NO_SIGNING: '1' },
      encoding: 'utf8',
    });
    expect(route).toMatch(/^Windows signing route: unsigned/);
  });
});

describe('workflows', () => {
  const read = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8');
  const signingSecret =
    /secrets\.(SM_|WIN_CSC|AZURE_|MAC_CSC|CSC_|APPLE_)|vars\.(WIN_SIGN_COMMAND|AZURE_SIGN)/;

  it('the nightly reads no signing secret and turns signing off', () => {
    const nightly = read('nightly.yml');
    expect(nightly).not.toMatch(signingSecret);
    expect(nightly).toMatch(/^ {2}QUADRION_NO_SIGNING: '1'$/m);
  });

  it('CI reads no signing secret', () => {
    expect(read('ci.yml')).not.toMatch(signingSecret);
  });

  it('the release signs only for a v* tag and removes the KeyLocker certificate in an always() step', () => {
    const release = read('release.yml');
    expect(release).toContain(
      "QUADRION_NO_SIGNING: ${{ !(github.ref_type == 'tag' && startsWith(github.ref_name, 'v')) && '1' || '0' }}",
    );
    expect(release).toMatch(/Remove the KeyLocker client certificate\n\s+if: always\(\)/);
    expect(release).toContain('signtool verify');
  });
});
