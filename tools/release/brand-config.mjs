#!/usr/bin/env node
// Write the effective electron-builder config for apps/desktop.
//
// apps/desktop/electron-builder.yml holds everything that does not depend on the product's
// identity. This script layers on top of it:
//   - identity from @aio/brand (productName, appId, executableName, copyright, Store display name)
//   - signing and notarisation switches derived from environment variables, so an unsigned
//     development build works with no setup and a release build signs when secrets are present
// and writes apps/desktop/build/generated/electron-builder.json (git-ignored), which extends
// the yml. Renaming the product means editing packages/brand/brand.json only.
//
// Usage: node tools/release/brand-config.mjs [--print]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const appDir = join(root, 'apps/desktop');
export const baseConfigPath = join(appDir, 'electron-builder.yml');
export const effectiveConfigPath = join(appDir, 'build/generated/electron-builder.json');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const has = (env, ...keys) => keys.every((k) => typeof env[k] === 'string' && env[k].length > 0);

/**
 * Windows signing mode, first match wins: Azure Trusted Signing, a .pfx, a cloud HSM command.
 * `company` is the default Azure publisher name.
 */
export function windowsSigning(env, company = '') {
  if (
    has(env, 'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE') &&
    has(env, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID')
  ) {
    // Azure Trusted Signing (Artifact Signing). electron-builder installs the TrustedSigning
    // PowerShell module and authenticates with AZURE_TENANT_ID / AZURE_CLIENT_ID plus
    // AZURE_CLIENT_SECRET (or another azure-identity credential) from the environment.
    // publisherName is required and must equal the certificate subject CN: the validated
    // organisation name, which is the company unless WIN_PUBLISHER_NAME says otherwise.
    return {
      mode: 'azure',
      win: {
        azureSignOptions: {
          endpoint: env.AZURE_SIGN_ENDPOINT,
          codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
          certificateProfileName: env.AZURE_SIGN_PROFILE,
          publisherName: env.WIN_PUBLISHER_NAME ?? company,
        },
      },
    };
  }
  if (has(env, 'WIN_CSC_LINK') || has(env, 'CSC_LINK')) {
    // electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD (or CSC_*) itself.
    return { mode: 'pfx', win: {} };
  }
  if (has(env, 'WIN_SIGN_COMMAND')) {
    // Cloud HSM (DigiCert KeyLocker, SSL.com eSigner, signtool with a KSP): run a command
    // template per file. Absolute path: electron-builder rejects relative hooks outside apps/desktop.
    return {
      mode: 'command',
      win: { signtoolOptions: { sign: join(root, 'tools/release/win-sign.mjs') } },
    };
  }
  return { mode: 'unsigned', win: {} };
}

/** Variables that switch Windows signing on; a Store build drops them (`storeBuildEnv`). */
export const WINDOWS_SIGNING_VARS = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'AZURE_SIGN_ENDPOINT',
  'AZURE_SIGN_ACCOUNT',
  'AZURE_SIGN_PROFILE',
  'WIN_SIGN_COMMAND',
];

/**
 * True when electron-builder arguments ask for a Microsoft Store package (`appx` / `msix`).
 * Microsoft signs Store submissions; signing it ourselves would fail anyway, because the
 * manifest publisher is the Partner Center CN, not our certificate's subject.
 */
export const isStoreBuild = (args) => args.some((a) => /^(appx|msix)$/i.test(a));

/** The environment for a Store build: every Windows signing switch removed. */
export function storeBuildEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !WINDOWS_SIGNING_VARS.includes(k)));
}

/** macOS signing identity and notarisation. */
export function macSigning(env) {
  const signed = has(env, 'CSC_LINK') || has(env, 'CSC_NAME');
  const notaryCreds =
    has(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') ||
    has(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID') ||
    has(env, 'APPLE_KEYCHAIN_PROFILE');
  return {
    mode: signed ? (notaryCreds ? 'signed+notarised' : 'signed') : 'ad-hoc',
    // "-" ad-hoc signs, so an unsigned Apple Silicon build still launches on the build machine.
    mac: signed ? { notarize: notaryCreds } : { identity: '-', notarize: false },
  };
}

/** Microsoft Store identity; placeholders keep local appx builds possible before Partner Center. */
export function storeIdentity(brand, env) {
  const companyId = brand.company.replace(/[^A-Za-z0-9]/g, '');
  // Partner Center identity lives in brand.json (public values); env vars override it.
  const store = brand.store ?? {};
  const placeholder =
    !has(env, 'STORE_IDENTITY_NAME', 'STORE_PUBLISHER') && !(store.identityName && store.publisher);
  return {
    placeholder,
    appx: {
      identityName:
        env.STORE_IDENTITY_NAME ?? store.identityName ?? `${companyId}.${brand.executableName}`,
      publisher: env.STORE_PUBLISHER ?? store.publisher ?? `CN=${companyId}Dev`,
      publisherDisplayName:
        env.STORE_PUBLISHER_DISPLAY_NAME ?? store.publisherDisplayName ?? brand.company,
      displayName: brand.productName,
      applicationId: brand.executableName.replace(/[^A-Za-z0-9.]/g, ''),
    },
  };
}

/**
 * macOS document type and URL scheme. electron-builder writes `fileAssociations` as
 * CFBundleDocumentTypes and `protocols` as CFBundleURLTypes; the exported UTI gives `.aio`
 * files a kind and icon in Finder. The app handles `<urlScheme>://` in its `open-url` handler.
 */
export function macIntegration(brand) {
  return {
    protocols: [{ name: `${brand.productName} link`, schemes: [brand.urlScheme], role: 'Viewer' }],
    extendInfo: {
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: `${brand.appId}.package`,
          UTTypeDescription: `${brand.productName} project package`,
          UTTypeConformsTo: ['public.data'],
          UTTypeIconFile: 'icon.icns',
          UTTypeTagSpecification: {
            'public.filename-extension': ['aio'],
            'public.mime-type': ['application/vnd.aio-package+zip'],
          },
        },
      ],
    },
  };
}

export function effectiveConfig(rawEnv = process.env, now = new Date()) {
  // CI maps absent secrets and variables to empty strings; treat those as unset.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v != null && v !== ''));
  const brand = readJson(join(root, 'packages/brand/brand.json'));
  const base = readFileSync(baseConfigPath, 'utf8');
  if (base.includes(brand.productName)) {
    throw new Error(
      `electron-builder.yml mentions "${brand.productName}". Identity belongs in packages/brand/brand.json.`,
    );
  }
  const require = createRequire(import.meta.url);
  const electronVersion = readJson(require.resolve('electron/package.json')).version;
  const win = windowsSigning(env, brand.company);
  const macOs = macIntegration(brand);
  const mac = macSigning(env);
  const store = storeIdentity(brand, env);

  const config = {
    extends: relative(appDir, baseConfigPath).replaceAll('\\', '/'),
    appId: brand.appId,
    productName: brand.productName,
    executableName: brand.executableName,
    copyright: `Copyright ${now.getFullYear()} ${brand.company}`,
    electronVersion,
    extraMetadata: {
      productName: brand.productName,
      description: brand.productName,
      author: { name: brand.company },
    },
    win: win.win,
    nsis: { shortcutName: brand.productName, uninstallDisplayName: brand.productName },
    // Project packages open in the app (NSIS registry entries, MSIX uap:FileTypeAssociation,
    // macOS document type). The only `.aio` association: electron-builder.yml declares none.
    // A package is never written, so the app is its viewer.
    fileAssociations: [
      {
        ext: 'aio',
        name: `${brand.executableName}.Package`,
        description: `${brand.productName} project package`,
        role: 'Viewer',
        mimeType: 'application/vnd.aio-package+zip',
        icon: 'icon',
        // macOS: the app owns the type it exports (macIntegration).
        rank: 'Owner',
      },
    ],
    protocols: macOs.protocols,
    appx: store.appx,
    mac: { ...mac.mac, extendInfo: macOs.extendInfo },
    dmg: { title: `${brand.productName} \${version}` },
  };
  return { config, summary: { win: win.mode, mac: mac.mode, storePlaceholder: store.placeholder } };
}

export function writeEffectiveConfig(env = process.env) {
  const { config, summary } = effectiveConfig(env);
  mkdirSync(dirname(effectiveConfigPath), { recursive: true });
  writeFileSync(effectiveConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  const log = (line) => process.stdout.write(`[brand-config] ${line}\n`);
  log(`${config.productName} ${config.appId}, Electron ${config.electronVersion}`);
  log(`Windows signing: ${summary.win}; macOS: ${summary.mac}`);
  if (summary.storePlaceholder) {
    log('Store identity: placeholders (set STORE_IDENTITY_NAME and STORE_PUBLISHER to submit)');
  }
  log(`wrote ${relative(root, effectiveConfigPath)}`);
  return { config, path: effectiveConfigPath };
}

if (
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href &&
  process.argv.includes('--summary')
) {
  // Signing modes as JSON for CI steps (`{"win":"azure","mac":"ad-hoc",...}`); writes nothing.
  process.stdout.write(`${JSON.stringify(effectiveConfig().summary)}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { config } = writeEffectiveConfig();
  if (process.argv.includes('--print'))
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}
