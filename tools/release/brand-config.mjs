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
//        node tools/release/brand-config.mjs --summary   signing modes as JSON, writes nothing
//        node tools/release/brand-config.mjs --route     the Windows signing route, writes nothing
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { envVar } from '../../packages/brand/src/env.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const appDir = join(root, 'apps/desktop');
export const baseConfigPath = join(appDir, 'electron-builder.yml');
export const effectiveConfigPath = join(appDir, 'build/generated/electron-builder.json');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const has = (env, ...keys) => keys.every((k) => typeof env[k] === 'string' && env[k].length > 0);

/** Absolute path of the electron-builder sign hook (electron-builder rejects relative hooks). */
const signHook = join(root, 'tools/release/win-sign.mjs');

/**
 * Variables of each Windows signing route. A build uses exactly one route: `windowsRouteEnv`
 * removes the variables of the others before electron-builder runs, so it cannot, for example,
 * also import a .pfx from WIN_CSC_LINK while the KeyLocker hook signs.
 */
export const WINDOWS_ROUTE_VARS = {
  azure: ['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE'],
  keylocker: [
    'SM_HOST',
    'SM_API_KEY',
    'SM_CLIENT_CERT_FILE',
    'SM_CLIENT_CERT_FILE_B64',
    'SM_CLIENT_CERT_PASSWORD',
    'SM_CODE_SIGNING_CERT_SHA1_HASH',
  ],
  pfx: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_KEY_PASSWORD'],
  command: ['WIN_SIGN_COMMAND'],
};

/** What each route is, for logs. Never includes a value. */
export const WINDOWS_ROUTE_LABELS = {
  azure: 'Azure Artifact Signing (electron-builder azureSignOptions)',
  keylocker:
    'DigiCert KeyLocker (signtool /sha1 through the DigiCert KSP, tools/release/win-sign.mjs)',
  pfx: 'certificate file (.pfx from WIN_CSC_LINK)',
  command: 'custom WIN_SIGN_COMMAND (tools/release/win-sign.mjs)',
  unsigned: 'none: unsigned test build',
};

/** True when DigiCert KeyLocker credentials are complete (the client certificate as a file or base64). */
const hasKeyLocker = (env) =>
  has(env, 'SM_HOST', 'SM_API_KEY', 'SM_CLIENT_CERT_PASSWORD', 'SM_CODE_SIGNING_CERT_SHA1_HASH') &&
  (has(env, 'SM_CLIENT_CERT_FILE') || has(env, 'SM_CLIENT_CERT_FILE_B64'));

/**
 * Windows signing route, first match wins: Azure Artifact Signing, DigiCert KeyLocker, a .pfx,
 * a custom cloud HSM command. `company` is the default Azure publisher name.
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
  if (hasKeyLocker(env)) {
    // DigiCert KeyLocker: release.yml installs the KeyLocker tools, writes the client certificate
    // to a temporary .p12 (SM_CLIENT_CERT_FILE) and syncs the certificate into the user store;
    // the hook then runs signtool /sha1 <SM_CODE_SIGNING_CERT_SHA1_HASH> through DigiCert's KSP.
    return { mode: 'keylocker', win: { signtoolOptions: { sign: signHook } } };
  }
  if (has(env, 'WIN_CSC_LINK') || has(env, 'CSC_LINK')) {
    // electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD (or CSC_*) itself.
    return { mode: 'pfx', win: {} };
  }
  if (has(env, 'WIN_SIGN_COMMAND')) {
    // Any other cloud HSM (SSL.com eSigner CodeSignTool, smctl sign, ...): a command template
    // run per file by the hook.
    return { mode: 'command', win: { signtoolOptions: { sign: signHook } } };
  }
  return { mode: 'unsigned', win: {} };
}

/** One log line naming the Windows route; safe to print (names only, no values). */
export const describeWindowsRoute = (mode) =>
  `Windows signing route: ${mode} (${WINDOWS_ROUTE_LABELS[mode] ?? 'unknown'})`;

/** Variables that switch Windows signing on; a Store build drops them (`storeBuildEnv`). */
export const WINDOWS_SIGNING_VARS = Object.values(WINDOWS_ROUTE_VARS).flat();

/** Variables that switch macOS signing or notarisation on. */
export const MAC_SIGNING_VARS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN_PROFILE',
];

const without = (env, keys) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));

/**
 * QUADRION_NO_SIGNING=1 (or the legacy STRATLAS_NO_SIGNING=1) turns every signing route off, whatever secrets the environment holds.
 * nightly.yml always sets it, and release.yml sets it for any run that is not a `v*` tag: a cloud
 * HSM plan has a yearly signature quota (DigiCert KeyLocker: 1,000), and only releases may use it.
 */
export const signingDisabled = (env) => {
  const v = envVar(env, 'NO_SIGNING');
  return v === '1' || v === 'true';
};

/** The environment with every Windows and macOS signing switch and credential removed. */
export function unsignedBuildEnv(env) {
  return without(env, [
    ...WINDOWS_SIGNING_VARS,
    ...MAC_SIGNING_VARS,
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ]);
}

/** The environment with the variables of every Windows route except `mode` removed. */
export function windowsRouteEnv(env, mode) {
  const others = Object.entries(WINDOWS_ROUTE_VARS)
    .filter(([route]) => route !== mode)
    .flatMap(([, keys]) => keys);
  return without(env, others);
}

/** True when electron-builder arguments build for Windows. */
export const isWindowsBuild = (args) =>
  args.some((a) => a === '--win' || a === '-w' || a === '--windows');

/**
 * The environment electron-builder sees: empty values dropped (CI maps absent secrets to ''),
 * everything removed when signing is disabled, nothing for a Store package, and for a Windows
 * build only the variables of the one route that `windowsSigning` picks.
 */
export function builderEnv(rawEnv, builderArgs) {
  let env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v != null && v !== ''));
  if (signingDisabled(env)) env = unsignedBuildEnv(env);
  if (isStoreBuild(builderArgs)) return storeBuildEnv(env);
  if (isWindowsBuild(builderArgs)) env = windowsRouteEnv(env, windowsSigning(env).mode);
  return env;
}

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
 * files a kind and icon in Finder. The app handles `<urlScheme>://` in its `open-url` handler,
 * and the legacy schemes (`stratlas://`, from before the rename) the same way.
 */
export function macIntegration(brand) {
  return {
    protocols: [
      {
        name: `${brand.productName} link`,
        schemes: [brand.urlScheme, ...(brand.legacyUrlSchemes ?? [])],
        role: 'Viewer',
      },
    ],
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
        // M9: exchange files (changes between copies) and identity cards
        {
          UTTypeIdentifier: `${brand.appId}.exchange`,
          UTTypeDescription: `${brand.productName} exchange file`,
          UTTypeConformsTo: ['public.data'],
          UTTypeIconFile: 'icon.icns',
          UTTypeTagSpecification: {
            'public.filename-extension': ['aiosync'],
            'public.mime-type': ['application/vnd.aio-exchange+zip'],
          },
        },
        {
          UTTypeIdentifier: `${brand.appId}.idcard`,
          UTTypeDescription: `${brand.productName} identity card`,
          UTTypeConformsTo: ['public.json'],
          UTTypeIconFile: 'icon.icns',
          UTTypeTagSpecification: {
            'public.filename-extension': ['aioid'],
            'public.mime-type': ['application/vnd.aio-idcard+json'],
          },
        },
      ],
    },
  };
}

/**
 * An electron-builder artifact name: `<executableName>-${version}-<os>-${arch}<suffix>`. The
 * executable name has no spaces, so file names stay easy to script and to put in a URL.
 */
export function artifactName(brand, os, suffix) {
  return `${brand.executableName}-\${version}-${os}-\${arch}${suffix}`;
}

export function effectiveConfig(rawEnv = process.env, now = new Date()) {
  // CI maps absent secrets and variables to empty strings; treat those as unset.
  const present = Object.fromEntries(
    Object.entries(rawEnv).filter(([, v]) => v != null && v !== ''),
  );
  const env = signingDisabled(present) ? unsignedBuildEnv(present) : present;
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
    // Installer and archive names carry the executable name (no spaces), e.g.
    // QuadrionAI-1.0.0-win-x64-setup.exe; the install folder and shortcuts use productName.
    nsis: {
      shortcutName: brand.productName,
      uninstallDisplayName: brand.productName,
      artifactName: artifactName(brand, 'win', '-setup.${ext}'),
    },
    portable: { artifactName: artifactName(brand, 'win', '-portable.${ext}') },
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
      // M9: an exchange file (.aiosync) is previewed, then applied to an open project
      {
        ext: 'aiosync',
        name: `${brand.executableName}.Exchange`,
        description: `${brand.productName} exchange file`,
        role: 'Editor',
        mimeType: 'application/vnd.aio-exchange+zip',
        icon: 'icon',
        rank: 'Owner',
      },
      // M9: an identity card (.aioid) adds a person to a team project
      {
        ext: 'aioid',
        name: `${brand.executableName}.IdentityCard`,
        description: `${brand.productName} identity card`,
        role: 'Viewer',
        mimeType: 'application/vnd.aio-idcard+json',
        icon: 'icon',
        rank: 'Owner',
      },
    ],
    protocols: macOs.protocols,
    appx: { ...store.appx, artifactName: artifactName(brand, 'win', '-store.msix') },
    mac: {
      ...mac.mac,
      extendInfo: macOs.extendInfo,
      artifactName: artifactName(brand, 'mac', '.${ext}'),
    },
    dmg: {
      title: `${brand.productName} \${version}`,
      artifactName: artifactName(brand, 'mac', '.${ext}'),
    },
  };
  const summary = {
    win: win.mode,
    mac: mac.mode,
    storePlaceholder: store.placeholder,
    // The certificate subject CN the release checks every signed exe against (release.yml).
    winPublisher: windowsPublisher(env, brand),
  };
  return { config, summary };
}

/**
 * The publisher a signed Windows build must carry: WIN_PUBLISHER_NAME (the certificate subject
 * CN), else `signing.windowsPublisher` from brand.json, else the company.
 */
export function windowsPublisher(env, brand) {
  return env.WIN_PUBLISHER_NAME || brand.signing?.windowsPublisher || brand.company;
}

export function writeEffectiveConfig(env = process.env) {
  const { config, summary } = effectiveConfig(env);
  mkdirSync(dirname(effectiveConfigPath), { recursive: true });
  writeFileSync(effectiveConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  const log = (line) => process.stdout.write(`[brand-config] ${line}\n`);
  log(`${config.productName} ${config.appId}, Electron ${config.electronVersion}`);
  log(describeWindowsRoute(summary.win));
  log(`macOS signing: ${summary.mac}`);
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
} else if (
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href &&
  process.argv.includes('--route')
) {
  // Dry run of the route choice: names the Windows route this environment would use, no values.
  process.stdout.write(`${describeWindowsRoute(effectiveConfig().summary.win)}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { config } = writeEffectiveConfig();
  if (process.argv.includes('--print'))
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}
