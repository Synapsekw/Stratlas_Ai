/**
 * The Windows AppUserModelID to set at start, or null to leave it alone. An MSIX package supplies
 * its own (`<PackageFamilyName>!App`); overriding it breaks taskbar grouping and pinning, jump lists
 * and notifications for the Store build. `windowsStore` is `process.windowsStore`, undefined outside
 * a package despite its type.
 */
export function appUserModelId(appId: string, windowsStore: boolean | undefined): string | null {
  return windowsStore === true ? null : appId;
}
