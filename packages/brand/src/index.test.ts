import { describe, expect, it } from 'vitest';
import {
  aliasLegacyEnv,
  brand,
  ENV_PREFIX,
  envVar,
  privacyPolicyLink,
  reportBrands,
  SYMBOL,
  urlSchemes,
  WORDMARK,
  type Brand,
} from './index';

describe('reportBrands', () => {
  it('offers white label first, then the client brands, with unique ids', () => {
    expect(reportBrands[0]?.id).toBe('whitelabel');
    expect(reportBrands.map((b) => b.id)).toEqual(expect.arrayContaining(['eand', 'zain']));
    expect(new Set(reportBrands.map((b) => b.id)).size).toBe(reportBrands.length);
  });
});

describe('brand', () => {
  it('has a product name and a reverse-DNS app id', () => {
    expect(brand.productName.length).toBeGreaterThan(0);
    expect(brand.appId).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/);
  });

  it('has lowercase URL schemes that are not the internal aio scheme', () => {
    for (const s of urlSchemes) {
      expect(s).toMatch(/^[a-z][a-z0-9+.-]*$/);
      expect(s).not.toBe('aio');
    }
  });

  it('is Quadrion AI, with a space-free executable name', () => {
    expect(brand.productName).toBe('Quadrion AI');
    expect(brand.temporary).toBe(false);
    expect(brand.executableName).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('keeps the app id and Store identity of the Stratlas builds, so installs upgrade in place', () => {
    expect(brand.appId).toBe('ai.synapse-solutions.stratlas');
    expect(brand.store?.identityName).toBe('SynapseSolutions.Stratlas');
  });

  it('answers the quadrion scheme first and still the legacy stratlas scheme', () => {
    expect(brand.urlScheme).toBe('quadrion');
    expect(urlSchemes).toEqual(['quadrion', 'stratlas']);
  });
});

describe('privacyPolicyLink', () => {
  it('is the https privacy policy address, or null while none is published', () => {
    const url = 'https://example.com/privacy';
    expect(privacyPolicyLink({ ...brand, privacyPolicyUrl: url })).toBe(url);
    expect(privacyPolicyLink({ ...brand, privacyPolicyUrl: '' })).toBeNull();
    const unset: Brand = { ...brand };
    delete unset.privacyPolicyUrl;
    expect(privacyPolicyLink(unset)).toBeNull();
    expect(
      privacyPolicyLink({ ...brand, privacyPolicyUrl: 'http://example.com/privacy' }),
    ).toBeNull();
    expect(privacyPolicyLink({ ...brand, privacyPolicyUrl: 'not a url' })).toBeNull();
  });

  it('reads brand.json by default, where it stays empty until the policy is published', () => {
    if (brand.privacyPolicyUrl) expect(privacyPolicyLink()).toBe(brand.privacyPolicyUrl);
    else expect(privacyPolicyLink()).toBeNull();
  });
});

describe('envVar and aliasLegacyEnv', () => {
  it('reads QUADRION_ first and falls back to STRATLAS_', () => {
    expect(envVar({ QUADRION_DATA: 'new', STRATLAS_DATA: 'old' }, 'DATA')).toBe('new');
    expect(envVar({ STRATLAS_DATA: 'old' }, 'DATA')).toBe('old');
    expect(envVar({}, 'DATA')).toBeUndefined();
    expect(ENV_PREFIX).toBe('QUADRION_');
  });

  it('copies legacy names onto unset new names only, in place', () => {
    const env: Record<string, string | undefined> = {
      STRATLAS_USER_DATA: 'C:/old',
      STRATLAS_E2E: '1',
      QUADRION_E2E: '0',
      OTHER: 'x',
    };
    expect(aliasLegacyEnv(env)).toEqual(['USER_DATA']);
    expect(env.QUADRION_USER_DATA).toBe('C:/old');
    expect(env.QUADRION_E2E).toBe('0');
    expect(env.STRATLAS_USER_DATA).toBe('C:/old');
    expect(aliasLegacyEnv(env)).toEqual([]);
  });
});

describe('marks', () => {
  it('has a four-piece symbol, a two-piece small cut and a two-part outlined wordmark', () => {
    expect(SYMBOL.pieces).toHaveLength(4);
    expect(SYMBOL.small).toHaveLength(2);
    expect(SYMBOL.viewBox).toBe('4 4 52 52');
    expect(SYMBOL.smallViewBox).toBe('4 4 53 53');
    for (const d of [...SYMBOL.pieces, ...SYMBOL.small]) expect(d).toMatch(/^M.*Z$/);
    expect(WORDMARK.quadrion.length).toBeGreaterThan(1000);
    expect(WORDMARK.ai).toMatch(/^M/);
  });
});
