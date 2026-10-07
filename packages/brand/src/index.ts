import raw from '../brand.json' with { type: 'json' };

export interface Brand {
  /** Display name (Quadrion AI; Stratlas until 7 Oct 2026). Change it here and nowhere else. */
  productName: string;
  /**
   * Reverse-DNS application id used by installers and the OS. It still ends in `stratlas` on purpose:
   * the id ties the installed app, its Windows registration and its vault entries together, so a
   * new installer replaces the old app instead of installing beside it. Never change it.
   */
  appId: string;
  /** File name of the executable and installers (no spaces: `QuadrionAI.exe`). */
  executableName: string;
  /**
   * URL scheme the OS hands to the app (`<scheme>://open?path=...`, registered in the macOS
   * Info.plist). Distinct from the internal `aio:` scheme, which only serves files inside the app.
   */
  urlScheme: string;
  /** Earlier URL schemes (`stratlas`), still registered and handled so old links keep working. */
  legacyUrlSchemes: string[];
  /** One-line tagline (brand kit). */
  tagline: string;
  company: string;
  /** True while the name is a working title (false since the Quadrion AI rename). */
  temporary: boolean;
  /**
   * Microsoft Store package identity from Partner Center, Product identity (public values). The
   * identity name was fixed when the name was first reserved and does not follow later renames.
   */
  store?: { identityName: string; publisher: string; publisherDisplayName: string };
  /**
   * Code-signing identity the app accepts for updates (ADR 0003). `windowsPublisher` is the exact
   * CN (or O) of the Authenticode certificate; absent, the signer must name `company`.
   */
  signing?: { windowsPublisher?: string };
}

export const brand: Brand = raw;

/** Every URL scheme the app answers: the current one first, then the legacy ones. */
export const urlSchemes: readonly string[] = [brand.urlScheme, ...brand.legacyUrlSchemes];

export { aliasLegacyEnv, ENV_PREFIX, envVar, LEGACY_ENV_PREFIX } from './env';
export { SYMBOL, WORDMARK } from './marks';

/** Report brand themes a project can use (wizard, PDF reports). The first is the default. */
export const reportBrands: readonly { id: string; label: string }[] = [
  { id: 'whitelabel', label: 'White label' },
  { id: 'eand', label: 'e&' },
  { id: 'zain', label: 'Zain' },
];
