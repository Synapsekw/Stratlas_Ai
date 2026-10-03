import raw from '../brand.json' with { type: 'json' };

export interface Brand {
  /** Display name. Temporary: change it here and nowhere else. */
  productName: string;
  /** Reverse-DNS application id used by installers and the OS. */
  appId: string;
  executableName: string;
  company: string;
  /** True while the name is a working title. */
  temporary: boolean;
}

export const brand: Brand = raw;
