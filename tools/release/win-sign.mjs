// electron-builder custom Windows sign hook for cloud HSM certificates.
//
// tools/release/brand-config.mjs points `win.signtoolOptions.sign` here for two routes:
//
// - keylocker: DigiCert KeyLocker. release.yml has installed the KeyLocker tools, written the
//   client certificate to SM_CLIENT_CERT_FILE and run `smctl windows certsync`, so the code-signing
//   certificate sits in the user store bound to DigiCert's KSP. This hook runs, per file,
//     signtool sign /sha1 <SM_CODE_SIGNING_CERT_SHA1_HASH> /tr http://timestamp.digicert.com /td SHA256 /fd SHA256 <file>
//   (DigiCert's documented GitHub flow:
//   https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-ksp-library-on-github.html).
//   The KSP reads SM_HOST, SM_API_KEY, SM_CLIENT_CERT_FILE and SM_CLIENT_CERT_PASSWORD from the
//   environment. SIGNTOOL_PATH names signtool.exe; otherwise it must be on PATH.
// - command: WIN_SIGN_COMMAND, a template run once per file with {file} replaced by the quoted
//   absolute path. It must timestamp and exit non-zero on failure. Example (SSL.com eSigner, see
//   docs/release/SECRETS.md):
//     CodeSignTool.bat sign -username="%ES_USERNAME%" ... -input_file_path={file}
//
// electron-builder calls the hook once per file and hash algorithm; electron-builder.yml asks for
// SHA-256 only, so each file costs one signature of the yearly quota. When WIN_SIGN_LOG names a
// file, each signed path is appended to it and release.yml reports the count.
//
// Dry run (prints the route and the command, the thumbprint redacted; signs nothing):
//   node tools/release/win-sign.mjs --dry-run <file>
import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { windowsSigning } from './brand-config.mjs';

export const TIMESTAMP_URL = 'http://timestamp.digicert.com';

/** The certificate's SHA-1 thumbprint without spaces or colons, upper case; throws (value-free) when malformed. */
export function normaliseThumbprint(value = '') {
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(hex)) {
    throw new Error('SM_CODE_SIGNING_CERT_SHA1_HASH is not a 40-character SHA-1 thumbprint');
  }
  return hex;
}

/**
 * How to sign `file` in this environment: `{ route, exe, args }` (run without a shell) for
 * KeyLocker, `{ route, shell }` for a WIN_SIGN_COMMAND template. Throws for routes that do not
 * use the hook, so a misconfigured build fails instead of shipping unsigned files.
 */
export function signInvocation(env, file) {
  const { mode } = windowsSigning(env);
  if (mode === 'keylocker') {
    const thumbprint = normaliseThumbprint(env.SM_CODE_SIGNING_CERT_SHA1_HASH);
    return {
      route: mode,
      exe: env.SIGNTOOL_PATH || 'signtool',
      args: [
        'sign',
        '/sha1',
        thumbprint,
        '/tr',
        TIMESTAMP_URL,
        '/td',
        'SHA256',
        '/fd',
        'SHA256',
        file,
      ],
    };
  }
  if (mode === 'command') {
    const template = env.WIN_SIGN_COMMAND;
    if (!template.includes('{file}')) throw new Error('WIN_SIGN_COMMAND must contain {file}');
    return { route: mode, shell: template.replaceAll('{file}', `"${file}"`) };
  }
  throw new Error(`win-sign: the ${mode} route does not sign through this hook`);
}

/** The invocation as one printable line, with the thumbprint redacted. */
export function describeInvocation(invocation) {
  if (invocation.shell) return `${invocation.route}: ${invocation.shell}`;
  const args = invocation.args.map((a, i) => (invocation.args[i - 1] === '/sha1' ? '***' : a));
  return `${invocation.route}: ${[invocation.exe, ...args].join(' ')}`;
}

/** @param {{ path: string, hash?: string }} configuration */
export default function sign(configuration) {
  // One signature per file: a second (SHA-1) pass would double the quota used.
  if (configuration.hash && configuration.hash !== 'sha256') {
    process.stdout.write(`[win-sign] skipped ${configuration.hash} for ${configuration.path}\n`);
    return;
  }
  const invocation = signInvocation(process.env, configuration.path);
  process.stdout.write(`[win-sign] ${invocation.route}: ${configuration.path}\n`);
  if (invocation.shell) execSync(invocation.shell, { stdio: 'inherit' });
  else execFileSync(invocation.exe, invocation.args, { stdio: 'inherit' });
  if (process.env.WIN_SIGN_LOG) appendFileSync(process.env.WIN_SIGN_LOG, `${configuration.path}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[process.argv.indexOf('--dry-run') + 1];
  if (!process.argv.includes('--dry-run') || !file) {
    process.stderr.write('usage: node tools/release/win-sign.mjs --dry-run <file>\n');
    process.exit(2);
  }
  process.stdout.write(`${describeInvocation(signInvocation(process.env, file))}\n`);
}
