import { describe, expect, it } from 'vitest';
import { refuseNonLocal } from './local.mjs';

const req = (method, headers) => ({ method, headers });

describe('refuseNonLocal', () => {
  it('serves the board on 127.0.0.1 and localhost', () => {
    expect(refuseNonLocal(req('GET', { host: '127.0.0.1:4178' }), 4178)).toBeNull();
    expect(refuseNonLocal(req('GET', { host: 'localhost:4178' }), 4178)).toBeNull();
    expect(
      refuseNonLocal(req('PUT', { host: '127.0.0.1:4178', origin: 'http://127.0.0.1:4178' }), 4178),
    ).toBeNull();
  });

  it('refuses another host name (DNS rebinding)', () => {
    expect(refuseNonLocal(req('GET', { host: 'evil.example:4178' }), 4178)).toMatch(/Host/);
    expect(refuseNonLocal(req('GET', {}), 4178)).toMatch(/Host/);
  });

  it('refuses a change sent from another site', () => {
    expect(
      refuseNonLocal(req('POST', { host: '127.0.0.1:4178', origin: 'http://evil.example' }), 4178),
    ).toMatch(/another site/);
    expect(
      refuseNonLocal(req('PUT', { host: '127.0.0.1:4178', 'sec-fetch-site': 'cross-site' }), 4178),
    ).toMatch(/another site/);
  });
});
