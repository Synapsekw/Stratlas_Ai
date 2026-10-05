import { describe, expect, it } from 'vitest';
import { brand, reportBrands } from './index';

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

  it('has a lowercase URL scheme that is not the internal aio scheme', () => {
    expect(brand.urlScheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
    expect(brand.urlScheme).not.toBe('aio');
  });
});
