import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baseConfigPath,
  effectiveConfig,
  isStoreBuild,
  macIntegration,
  macSigning,
  storeBuildEnv,
  windowsPublisher,
  windowsSigning,
} from './brand-config.mjs';

const azure = {
  AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGN_ACCOUNT: 'acct',
  AZURE_SIGN_PROFILE: 'profile',
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
};

describe('windowsSigning', () => {
  it('is unsigned with no secrets, so forks and pull requests still build', () => {
    expect(windowsSigning({}).mode).toBe('unsigned');
  });

  it('prefers Azure Trusted Signing and names the company as publisher', () => {
    const s = windowsSigning({ ...azure, WIN_CSC_LINK: 'cert.pfx' }, 'Synapse Solutions');
    expect(s.mode).toBe('azure');
    expect(s.win.azureSignOptions).toEqual({
      endpoint: azure.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: 'acct',
      certificateProfileName: 'profile',
      publisherName: 'Synapse Solutions',
    });
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('takes WIN_PUBLISHER_NAME when the certificate subject differs from the company', () => {
    const s = windowsSigning({ ...azure, WIN_PUBLISHER_NAME: 'Synapse Solutions W.L.L.' }, 'X');
    expect(s.win.azureSignOptions.publisherName).toBe('Synapse Solutions W.L.L.');
  });

  it('skips Azure when the account is set but the credentials are not', () => {
    expect(windowsSigning({ ...azure, AZURE_TENANT_ID: undefined }).mode).toBe('unsigned');
    expect(windowsSigning({ ...azure, AZURE_CLIENT_ID: '' }).mode).toBe('unsigned');
  });

  it('uses a pfx from WIN_CSC_LINK or CSC_LINK', () => {
    expect(windowsSigning({ WIN_CSC_LINK: 'base64' }).mode).toBe('pfx');
    expect(windowsSigning({ CSC_LINK: 'base64' }).mode).toBe('pfx');
  });

  it('falls back to the cloud HSM command', () => {
    expect(windowsSigning({ WIN_SIGN_COMMAND: 'smctl sign --input {file}' }).mode).toBe('command');
  });
});

describe('Store builds', () => {
  it('are recognised from the electron-builder target', () => {
    expect(isStoreBuild(['--win', 'appx'])).toBe(true);
    expect(isStoreBuild(['--win', 'msix'])).toBe(true);
    expect(isStoreBuild(['--win'])).toBe(false);
  });

  it('drop every Windows signing switch, so the MSIX stays unsigned', () => {
    const env = storeBuildEnv({
      ...azure,
      WIN_CSC_LINK: 'x',
      WIN_SIGN_COMMAND: 'y',
      SM_HOST: 'h',
      SM_API_KEY: 'k',
      SM_CLIENT_CERT_FILE: 'c.p12',
      SM_CLIENT_CERT_PASSWORD: 'p',
      SM_CODE_SIGNING_CERT_SHA1_HASH: 'a'.repeat(40),
      PATH: '/bin',
    });
    expect(windowsSigning(env).mode).toBe('unsigned');
    expect(env.PATH).toBe('/bin');
  });
});

describe('macSigning', () => {
  it('ad-hoc signs without a certificate', () => {
    expect(macSigning({})).toEqual({
      mode: 'ad-hoc',
      mac: { identity: '-', notarize: false },
    });
  });

  it('signs without notarising when only the certificate is present', () => {
    expect(macSigning({ CSC_LINK: 'p12' }).mode).toBe('signed');
  });

  it('notarises with an Apple ID and app-specific password', () => {
    const env = {
      CSC_LINK: 'p12',
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'pw',
      APPLE_TEAM_ID: 'TEAM123456',
    };
    expect(macSigning(env)).toEqual({ mode: 'signed+notarised', mac: { notarize: true } });
  });

  it('notarises with an App Store Connect API key', () => {
    const env = {
      CSC_LINK: 'p12',
      APPLE_API_KEY: 'k.p8',
      APPLE_API_KEY_ID: 'id',
      APPLE_API_ISSUER: 'i',
    };
    expect(macSigning(env).mode).toBe('signed+notarised');
  });

  it('does not notarise an Apple ID without the team id', () => {
    const env = { CSC_LINK: 'p12', APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw' };
    expect(macSigning(env).mode).toBe('signed');
  });
});

describe('macIntegration', () => {
  const brand = { productName: 'Stratlas', appId: 'ai.example.stratlas', urlScheme: 'stratlas' };

  it('registers the URL scheme and exports the .aio type', () => {
    const m = macIntegration(brand);
    expect(m.protocols).toEqual([{ name: 'Stratlas link', schemes: ['stratlas'], role: 'Viewer' }]);
    const [uti] = m.extendInfo.UTExportedTypeDeclarations;
    expect(uti.UTTypeIdentifier).toBe('ai.example.stratlas.package');
    expect(uti.UTTypeTagSpecification['public.filename-extension']).toEqual(['aio']);
    const exts = m.extendInfo.UTExportedTypeDeclarations.map(
      (u) => u.UTTypeTagSpecification['public.filename-extension'][0],
    );
    expect(exts).toEqual(['aio', 'aiosync', 'aioid']);
  });
});

describe('effectiveConfig', () => {
  it('carries the Store identity, the .aio association and the URL scheme', () => {
    const { config, summary } = effectiveConfig({}, new Date('2026-10-05'));
    expect(summary).toEqual({
      win: 'unsigned',
      mac: 'ad-hoc',
      storePlaceholder: false,
      winPublisher: 'Synapse Solutions',
    });
    expect(config.appx.identityName).toBe('SynapseSolutions.Stratlas');
    expect(config.appx.publisher).toMatch(/^CN=/);
    expect(config.fileAssociations.map((f) => f.ext)).toEqual(['aio', 'aiosync', 'aioid']);
    expect(config.protocols[0].schemes).toEqual(['stratlas']);
    expect(config.mac.extendInfo.UTExportedTypeDeclarations).toHaveLength(3);
    expect(config.copyright).toBe('Copyright 2026 Synapse Solutions');
  });

  it('treats empty CI variables as unset', () => {
    const { summary } = effectiveConfig({ WIN_CSC_LINK: '', CSC_LINK: '', APPLE_ID: '' });
    expect(summary.win).toBe('unsigned');
    expect(summary.mac).toBe('ad-hoc');
  });

  it('signs nothing with STRATLAS_NO_SIGNING=1, whatever secrets exist', () => {
    const env = {
      STRATLAS_NO_SIGNING: '1',
      WIN_CSC_LINK: 'pfx',
      CSC_LINK: 'p12',
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'pw',
      APPLE_TEAM_ID: 'TEAM123456',
    };
    const { config, summary } = effectiveConfig(env);
    expect(summary.win).toBe('unsigned');
    expect(summary.mac).toBe('ad-hoc');
    expect(config.win).toEqual({});
  });

  it('reports WIN_PUBLISHER_NAME as the publisher to check', () => {
    const { summary } = effectiveConfig({ WIN_PUBLISHER_NAME: 'Synapse Solutions Company W.L.L.' });
    expect(summary.winPublisher).toBe('Synapse Solutions Company W.L.L.');
  });
});

describe('windowsPublisher', () => {
  const brand = { company: 'Synapse Solutions' };
  it('prefers WIN_PUBLISHER_NAME, then signing.windowsPublisher, then the company', () => {
    expect(
      windowsPublisher(
        { WIN_PUBLISHER_NAME: 'A' },
        { ...brand, signing: { windowsPublisher: 'B' } },
      ),
    ).toBe('A');
    expect(windowsPublisher({}, { ...brand, signing: { windowsPublisher: 'B' } })).toBe('B');
    expect(windowsPublisher({}, brand)).toBe('Synapse Solutions');
  });
});

describe('the signing hash setting in electron-builder.yml', () => {
  const yml = readFileSync(baseConfigPath, 'utf8');
  it('signs with SHA-256 only, one signature per file', () => {
    expect(yml).toMatch(/^\s+signingHashAlgorithms: \[sha256\]$/m);
  });
  it('signs only .exe files (no signExts), so DLLs and .node addons are not re-signed', () => {
    expect(yml).not.toMatch(/^\s*signExts:/m);
  });
});
