import type {
  ComparisonPreset,
  DesignEntry,
  DesignPickRef,
  PresetSurfaceRef,
  SurfaceRef,
  SurveyTemplate,
} from '@aio/schema';

/**
 * Design layers a template leaves to pick (G9's industry sets, data-conventions section 27). A
 * preset side `{ kind: 'design-pick', role, hint }` names a role (`og`, `subgrade`, `final-cap`)
 * rather than a design id that no real project has. The first time such a template is used on a
 * site, the app asks for the design surface layer of each role (the hint shown, a layer whose name
 * matches preselected) and keeps the answer in `SurveySettings.designRoles`; a measurement's items
 * then name that layer. A site with no design surface yet may go on without those comparisons.
 */

/** The site's pick for each role (`SurveySettings.designRoles`). */
export type RolePicks = Readonly<Record<string, { design: string; layer: string }>>;

/** One design surface layer a role can be given. */
export interface DesignLayerOption {
  design: string;
  layer: string;
  /** `Design name, layer name`, as the pickers show it. */
  label: string;
  /** The layer's own name. */
  name: string;
}

const isPick = (r: PresetSurfaceRef): r is DesignPickRef => r.kind === 'design-pick';

/** The roles a template's presets leave to pick, each once, in preset order. */
export function designRolesOf(t: Pick<SurveyTemplate, 'comparisons'>): DesignPickRef[] {
  const out = new Map<string, DesignPickRef>();
  for (const p of t.comparisons)
    for (const side of [p.from, p.to])
      if (isPick(side) && !out.has(side.role)) out.set(side.role, side);
  return [...out.values()];
}

/** Every design surface layer of the site (archived layers left out), for the role pickers. */
export function designLayerOptions(designs: readonly DesignEntry[]): DesignLayerOption[] {
  return designs.flatMap((d) =>
    d.layers
      .filter((l) => l.kind === 'surface' && !l.archived)
      .map((l) => ({ design: d.id, layer: l.id, label: `${d.name}, ${l.name}`, name: l.name })),
  );
}

/** The picks that still name a design surface layer of the site (a removed one is asked again). */
export function validPicks(
  picks: RolePicks | undefined,
  designs: readonly DesignEntry[],
): Record<string, { design: string; layer: string }> {
  const have = new Set(designLayerOptions(designs).map((o) => `${o.design}/${o.layer}`));
  return Object.fromEntries(
    Object.entries(picks ?? {}).filter(([, p]) => have.has(`${p.design}/${p.layer}`)),
  );
}

/** The roles of a template the site has no valid pick for: what the app asks before it is used. */
export function missingRoles(
  t: Pick<SurveyTemplate, 'comparisons'>,
  picks: RolePicks | undefined,
  designs: readonly DesignEntry[],
): DesignPickRef[] {
  const valid = validPicks(picks, designs);
  return designRolesOf(t).filter((r) => !(r.role in valid));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The layer a role most likely means, to preselect: a layer (or design) named after the role or its
 * hint (`og`, `Original ground`), or the only design surface of the site. Null when unsure.
 */
export function suggestLayer(
  role: DesignPickRef,
  options: readonly DesignLayerOption[],
): DesignLayerOption | null {
  // the role (`final-cap`), the hint (`Final cap`) and a short form in brackets (`Original ground (OG)`)
  const short = /\(([^)]+)\)/.exec(role.hint)?.[1] ?? '';
  const keys = [role.role, role.hint, role.hint.replace(/\([^)]*\)/g, ''), short]
    .map(words)
    .filter(Boolean);
  const named = options.find((o) => [o.layer, o.name].some((n) => keys.includes(words(n))));
  if (named) return named;
  return options.length === 1 ? (options[0] ?? null) : null;
}

/**
 * A preset with its design layers picked: each `design-pick` side becomes the site's
 * `DesignSurfaceRef`; null while a role has no pick (the preset is left out then).
 */
export function resolvePreset(p: ComparisonPreset, picks: RolePicks = {}): ComparisonPreset | null {
  const side = (r: PresetSurfaceRef): SurfaceRef | null => {
    if (!isPick(r)) return r;
    const pick = picks[r.role];
    return pick ? { kind: 'design', design: pick.design, layer: pick.layer } : null;
  };
  const from = side(p.from);
  const to = side(p.to);
  return from && to ? { ...p, from, to } : null;
}
