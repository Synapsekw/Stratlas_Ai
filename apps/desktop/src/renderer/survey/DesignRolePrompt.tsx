/**
 * **Pick design layers** (M11 G9, data-conventions section 27): a template that compares to a
 * design (the industry sets' "OG to subgrade design", "Cell progress") names roles, not design ids.
 * The first time it is used on a site, this asks which design surface layer each role means, the
 * role's words shown as the hint and a layer named after it preselected. The answer is kept in the
 * site settings (`designRoles`), so the next use goes straight to drawing. A site without a design
 * surface can go on without those comparisons.
 */
import { suggestLayer } from '@aio/survey';
import { Icon, useFocusTrap } from '@aio/ui';
import { useRef, useState } from 'react';
import { answerRoles, cancelRoles, useMeasure, type RolePrompt } from './measureStore';

const key = (o: { design: string; layer: string }) => `${o.design}/${o.layer}`;

export function DesignRolePrompt() {
  const prompt = useMeasure((s) => s.rolePrompt);
  return prompt ? <PromptDialog key={prompt.template.id} prompt={prompt} /> : null;
}

function PromptDialog({ prompt }: { prompt: RolePrompt }) {
  const { template, roles, options, error } = prompt;
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      roles.map((r) => {
        const s = suggestLayer(r, options);
        return [r.role, s ? key(s) : ''];
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: cancelRoles });
  const all = roles.every((r) => chosen[r.role]);
  const use = async (withLayers: boolean) => {
    setBusy(true);
    const picks = withLayers
      ? Object.fromEntries(
          roles.flatMap((r) => {
            const o = options.find((x) => key(x) === chosen[r.role]);
            return o ? [[r.role, { design: o.design, layer: o.layer }]] : [];
          }),
        )
      : null;
    await answerRoles(picks);
    setBusy(false);
  };
  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sv-roles-title"
      data-testid="survey-design-roles"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancelRoles();
      }}
    >
      <div className="sv-dialog sv-units">
        <header className="sv-head" role="none">
          <h2 id="sv-roles-title">Design layers for {template.name}</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={cancelRoles}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {options.length > 0 ? (
          <p className="small faint">
            This template compares to a design. Pick the design surface each one means on this site;
            the choice is kept for the next time.
          </p>
        ) : (
          <p className="small faint" data-testid="survey-design-roles-none">
            This template compares to a design, and this site has no design surface yet. Import a
            design (Survey measurements, Site data, Designs) to use those comparisons, or go on
            without them.
          </p>
        )}
        {options.length > 0 && (
          <div className="sv-unit-grid">
            {roles.map((r) => (
              <label key={r.role} className="sv-field">
                <span>{r.hint}</span>
                <select
                  className="sv-input"
                  value={chosen[r.role] ?? ''}
                  data-testid={`survey-design-role-${r.role}`}
                  onChange={(e) => {
                    setChosen({ ...chosen, [r.role]: e.target.value });
                  }}
                >
                  <option value="">Pick a design layer</option>
                  {options.map((o) => (
                    <option key={key(o)} value={key(o)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p className="notice danger small" role="alert">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        <footer className="sv-foot" role="none">
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            data-testid="survey-design-roles-skip"
            onClick={() => {
              void use(false);
            }}
          >
            Without design comparisons
          </button>
          <span className="sv-grow" />
          <button type="button" className="btn sm ghost" onClick={cancelRoles}>
            Cancel
          </button>
          {options.length > 0 && (
            <button
              type="button"
              className="btn sm primary"
              disabled={!all || busy}
              data-testid="survey-design-roles-use"
              onClick={() => {
                void use(true);
              }}
            >
              Use these layers
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
