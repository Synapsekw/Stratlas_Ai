import { readFile } from 'node:fs/promises';

/** The one ODM release this build installs (ADR 0012). Never a floating "latest". */
export interface OdmPin {
  version: string;
  url: string;
  /** Size of the setup in bytes. */
  size: number;
  /** SHA-256 of the setup, lowercase hex. */
  sha256: string;
  /** About how much the installed folder takes on disk. */
  installedBytes: number;
  /** File name of the downloaded setup. */
  file: string;
}

export const ODM_PIN: OdmPin = {
  version: '3.6.2',
  url: 'https://github.com/OpenDroneMap/ODM/releases/download/v3.6.2/ODM_Setup_3.6.2.exe',
  size: 244_864_104,
  sha256: 'c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294',
  // measured 1,006,316,511 bytes in 11,935 files (C3)
  installedBytes: 1_100_000_000,
  file: 'ODM_Setup_3.6.2.exe',
};

/** Inno Setup, silent and per user (C1); `/DIR=<folder>` is added by the installer. */
export const SETUP_ARGS: readonly string[] = [
  '/VERYSILENT',
  '/SUPPRESSMSGBOXES',
  '/NORESTART',
  '/CURRENTUSER',
];

export const UNINSTALL_ARGS: readonly string[] = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];

/** Files a working ODM folder holds (C4), relative to it. */
export const REQUIRED_FILES: readonly string[] = [
  'run.bat',
  'winrun.bat',
  'win32env.bat',
  'VERSION',
  'venv\\Scripts\\python.exe',
];

/** ODM 3.6.2's setup has no administrator step (C2). */
export const SETUP_MAY_ASK_ADMIN = false;

/** The pin, or in end to end tests the JSON pin named by `QUADRION_ODM_PIN_FILE` (a local fake). */
export async function pinFrom(env: Record<string, string | undefined>): Promise<OdmPin> {
  const file = env.QUADRION_ODM_PIN_FILE;
  if (env.QUADRION_E2E !== '1' || !file) return ODM_PIN;
  return JSON.parse(await readFile(file, 'utf8')) as OdmPin;
}
