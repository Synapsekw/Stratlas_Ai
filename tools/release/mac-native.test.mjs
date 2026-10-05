import { describe, expect, it } from 'vitest';
import { MAC_NATIVE_PACKAGES, missingMacNativePackages } from './mac-native.mjs';

describe('missingMacNativePackages', () => {
  it('lists the architectures pnpm did not install', () => {
    const installed = new Set(['@napi-rs/keyring-darwin-arm64/package.json']);
    const resolve = (id) => {
      if (!installed.has(id)) throw new Error(`Cannot find module '${id}'`);
      return `/node_modules/${id}`;
    };
    expect(missingMacNativePackages(resolve)).toEqual(['@napi-rs/keyring-darwin-x64']);
  });

  it('is empty when both architectures are present', () => {
    expect(missingMacNativePackages((id) => id)).toEqual([]);
    expect(MAC_NATIVE_PACKAGES).toHaveLength(2);
  });
});
