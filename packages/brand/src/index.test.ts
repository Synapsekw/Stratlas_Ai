import { describe, expect, it } from 'vitest';
import { brand } from './index';

describe('brand', () => {
  it('has a product name and a reverse-DNS app id', () => {
    expect(brand.productName.length).toBeGreaterThan(0);
    expect(brand.appId).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/);
  });
});
