import { execFile } from 'node:child_process';
import { extname } from 'node:path';

/** What Windows says about an installer file. */
export interface Probe {
  /** Authenticode status: Valid, NotSigned, HashMismatch, NotTrusted, UnknownError... */
  status: string;
  /** Subject of the signing certificate, empty when unsigned. */
  signer: string;
  productVersion: string;
  fileVersion: string;
}

export interface VerifyDeps {
  platform: string;
  currentVersion: string;
  /** The signer subject must name this company (from @aio/brand). */
  publisher: string;
  /**
   * Exact signing identity from brand.json (`signing.windowsPublisher`), when configured: the
   * certificate's CN or O must equal it. Without it, CN or O must contain `publisher`.
   */
  signingIdentity?: string | undefined;
  /** The installer must hold exactly this version (an update the feed announced). */
  expectedVersion?: string | undefined;
  exists: (path: string) => Promise<boolean>;
  probe: (path: string) => Promise<Probe>;
}

export type VerifyResult =
  { ok: true; version: string; current: string; signer: string } | { ok: false; error: string };

const parts = (v: string) =>
  v
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 4)
    .map((p) => Number.parseInt(p, 10) || 0);

/** Compare dotted versions numerically: negative, zero or positive. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Attribute values of an X.500 subject (`CN=Name, O="Org, Inc", C=AE`), keys upper-case. */
export function subjectParts(subject: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\s*([A-Za-z.0-9]+)\s*=\s*("(?:[^"]|"")*"|[^,]*)\s*(?:,|$)/g;
  for (const m of subject.matchAll(re)) {
    const key = (m[1] ?? '').toUpperCase();
    let value = (m[2] ?? '').trim();
    if (value.startsWith('"')) value = value.slice(1, -1).replaceAll('""', '"');
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/** The certificate's common name or organisation is (or, without `exact`, contains) `expected`. */
export function signerMatches(subject: string, expected: string, exact: boolean): boolean {
  const want = expected.trim().toLowerCase();
  if (!want) return false;
  const parts = subjectParts(subject);
  return ['CN', 'O'].some((k) => {
    const v = parts.get(k)?.toLowerCase();
    return v !== undefined && (exact ? v === want : v.includes(want));
  });
}

/** "1.2.3.0" to "1.2.3": electron-builder writes a four-part file version. */
const threePart = (v: string) => parts(v).slice(0, 3).join('.');

/**
 * Check an installer picked by the person before running it: a Windows `.exe`, a valid
 * Authenticode signature from our publisher, and a newer version than the running app.
 */
export async function verifyInstaller(path: string, d: VerifyDeps): Promise<VerifyResult> {
  if (d.platform !== 'win32') {
    return {
      ok: false,
      error:
        'Installing an update from a file works on Windows. On macOS, open the new .dmg and replace the app.',
    };
  }
  if (extname(path).toLowerCase() !== '.exe') {
    return { ok: false, error: 'Choose the installer, a signed .exe file.' };
  }
  if (!(await d.exists(path))) return { ok: false, error: 'The installer file was not found.' };
  let probe: Probe;
  try {
    probe = await d.probe(path);
  } catch (e) {
    return {
      ok: false,
      error: `The installer could not be checked: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (probe.status === 'NotSigned' || !probe.signer) {
    return {
      ok: false,
      error:
        'This installer is not signed. Only signed installers from the publisher can be installed.',
    };
  }
  if (probe.status !== 'Valid') {
    return {
      ok: false,
      error: `The installer's signature is not valid (${probe.status}). It may have been changed after signing.`,
    };
  }
  if (!signerMatches(probe.signer, d.signingIdentity ?? d.publisher, Boolean(d.signingIdentity))) {
    return {
      ok: false,
      error: `The installer is signed by "${probe.signer}", not by ${d.signingIdentity ?? d.publisher}.`,
    };
  }
  const raw = probe.productVersion.trim() || probe.fileVersion.trim();
  if (!raw) return { ok: false, error: 'The installer does not say which version it holds.' };
  const version = threePart(raw);
  if (d.expectedVersion !== undefined && compareVersions(version, d.expectedVersion) !== 0) {
    return {
      ok: false,
      error: `The downloaded installer holds version ${version}, not ${d.expectedVersion} as the update feed says.`,
    };
  }
  const cmp = compareVersions(version, d.currentVersion);
  if (cmp === 0) {
    return { ok: false, error: `Version ${version} is already installed.` };
  }
  if (cmp < 0) {
    return {
      ok: false,
      error: `This installer holds version ${version}, older than the installed ${d.currentVersion}.`,
    };
  }
  return { ok: true, version, current: d.currentVersion, signer: probe.signer };
}

/** Parse the JSON line printed by PROBE_SCRIPT. */
export function parseProbe(json: string): Probe {
  const o = JSON.parse(json) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    status: str(o.status),
    signer: str(o.signer),
    productVersion: str(o.product),
    fileVersion: str(o.file),
  };
}

// The path travels in an environment variable, never inside the command text.
const PROBE_SCRIPT = [
  '$p = $env:AIO_INSTALLER',
  '$s = Get-AuthenticodeSignature -LiteralPath $p',
  '$v = (Get-Item -LiteralPath $p).VersionInfo',
  "$signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }",
  '[pscustomobject]@{ status = [string]$s.Status; signer = $signer; product = $v.ProductVersion; file = $v.FileVersion } | ConvertTo-Json -Compress',
].join('; ');

/** Ask Windows (PowerShell) for the Authenticode status and version of a file. */
export function probeWithPowerShell(path: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      { env: { ...process.env, AIO_INSTALLER: path }, windowsHide: true, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          reject(new Error(err.message));
          return;
        }
        try {
          resolve(parseProbe(stdout.trim()));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  });
}
