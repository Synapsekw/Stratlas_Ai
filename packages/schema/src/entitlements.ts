/**
 * The licence seam (M9 for M10). Code that offers a team or audit feature asks `can(...)`; every
 * M9 build answers true. M10's licence work (L3) replaces the provider, never the call sites. Roles
 * (what a person may do in a project) are a separate check and neither replaces the other.
 *
 * Whatever M10 decides, a lapsed licence keeps reading, pulling, Verify and audit exports ("never
 * lock people out of their data"): `ALWAYS_ALLOWED` lists those and no provider can refuse them.
 */

export const ENTITLEMENTS = [
  'journal.history',
  'audit.export',
  'audit.verify',
  'exchange.files',
  'team.share',
  'team.sync',
  'team.hub',
  'team.server',
  'team.pull',
  'collab.comment',
  'collab.assign',
  'collab.approve',
  // M11 surveying (decision 7): all allowed in M11 builds; M12 maps them to plans.
  'survey.measure',
  'survey.designs',
  'survey.hydro',
  'survey.haul',
  'survey.ai',
] as const;

export type Entitlement = (typeof ENTITLEMENTS)[number];

/** Never refused, whatever the licence state. */
export const ALWAYS_ALLOWED: readonly Entitlement[] = [
  'journal.history',
  'audit.export',
  'audit.verify',
  'team.pull',
];

export interface EntitlementProvider {
  can(entitlement: Entitlement): boolean;
}

/** M9: everything is allowed. */
export const allowAll: EntitlementProvider = { can: () => true };

let provider: EntitlementProvider = allowAll;

/** Install the provider (M10). Tests restore `allowAll` afterwards. */
export function setEntitlementProvider(next: EntitlementProvider): void {
  provider = next;
}

/** May this installed app do `entitlement`. */
export function can(entitlement: Entitlement): boolean {
  return ALWAYS_ALLOWED.includes(entitlement) || provider.can(entitlement);
}
