// A universal macOS app needs the native addons of both architectures. pnpm installs only the
// host's optional platform package (`@napi-rs/keyring-darwin-arm64` on Apple silicon), so an
// Intel Mac would fail to load the keyring and the app would not start. The release workflow
// installs both (supportedArchitectures); this check stops a local build that did not.

/** Platform packages every universal build must ship. */
export const MAC_NATIVE_PACKAGES = ['@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-darwin-x64'];

/** Packages from MAC_NATIVE_PACKAGES that `resolve` cannot find. */
export function missingMacNativePackages(resolve) {
  return MAC_NATIVE_PACKAGES.filter((name) => {
    try {
      resolve(`${name}/package.json`);
      return false;
    } catch {
      return true;
    }
  });
}

/** How to install the missing packages, for the error message. */
export const MAC_NATIVE_HINT = [
  'Install both macOS architectures before `dist:mac`: add to pnpm-workspace.yaml',
  '  supportedArchitectures:',
  '    os: [current]',
  '    cpu: [arm64, x64]',
  'then run `pnpm install` (do not commit that change; the release workflow adds it itself).',
].join('\n');
