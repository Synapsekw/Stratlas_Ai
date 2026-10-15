import type { Assembly, AssemblyKind, ProcModel, ScaleRecord } from '@aio/schema';
import { useT } from '@aio/ui';
import { ComponentCard } from './ComponentCard';
import { ComponentTree } from './ComponentTree';

/**
 * The Components section of the Model builder for an engineering model: the tree and the selected
 * component's card, what is shown in the view, what is still unresolved, photos that may show
 * another asset, and the model file check (what was left out or simplified, never silent). The host
 * keeps the model and runs the rebuild; this renders and reports.
 */
export interface ComponentsPanel {
  selected: string | null;
  hidden: readonly string[];
  /** Thumbnail URLs by evidence reference, for the card. */
  thumbnails: Readonly<Record<string, string>>;
  /** The model's scale record (absent: not recorded). */
  scale?: ScaleRecord | undefined;
  /** The scan or source layer and the model are each shown or hidden in the view. */
  sourceVisible: boolean;
  modelVisible: boolean;
  /** Things the run could not settle (`model.evidence.unresolved` and the assembler's list). */
  unresolved: readonly string[];
  /** Identity conflicts of the photos, as the proposal reports them. */
  conflicts: readonly { imageIds: readonly string[]; reason: string }[];
  /** The last model file build, or null before one. */
  report: {
    failed: readonly { id: string; reason: string }[];
    simplified: readonly { id: string; detail: string }[];
    overBudget: boolean;
    notes: readonly string[];
  } | null;
  /** Values were changed and the model is waiting to be rebuilt. */
  stale: boolean;
  locked?: boolean;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onStatus: (ids: readonly string[] | 'all', status: Assembly['status']) => void;
  onRemove: (id: string) => void;
  onAdd: (kind: AssemblyKind) => void;
  onField: (id: string, key: string, value: number | string | boolean) => void;
  onFocus: (id: string) => void;
  onSourceVisible: (visible: boolean) => void;
  onModelVisible: (visible: boolean) => void;
  onRebuild: () => void;
}

export function ComponentsSection({ model, panel }: { model: ProcModel; panel: ComponentsPanel }) {
  const t = useT();
  const selected = model.assemblies.find((a) => a.id === panel.selected) ?? null;
  const locked = panel.locked === true;
  const r = panel.report;
  const clean = r !== null && r.failed.length === 0 && r.simplified.length === 0 && !r.overBudget;
  return (
    <div className="mb-sec" data-testid="components-section" aria-label={t('review.components')}>
      <h3>{t('review.components')}</h3>

      <div className="mb-row" role="group" aria-label={t('review.visibility')}>
        <label className="mb-check">
          <input
            type="checkbox"
            checked={panel.sourceVisible}
            onChange={(e) => {
              panel.onSourceVisible(e.target.checked);
            }}
          />
          <span>{t('review.showScan')}</span>
        </label>
        <label className="mb-check">
          <input
            type="checkbox"
            checked={panel.modelVisible}
            onChange={(e) => {
              panel.onModelVisible(e.target.checked);
            }}
          />
          <span>{t('review.showModel')}</span>
        </label>
      </div>

      {panel.unresolved.length > 0 && (
        <div className="mb-cmp-note" data-testid="unresolved">
          <h4>{t('review.unresolved')}</h4>
          <ul>
            {panel.unresolved.map((u, i) => (
              <li key={`${String(i)}:${u}`}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {panel.conflicts.length > 0 && (
        <div className="mb-cmp-note bad" role="alert" data-testid="conflicts">
          <h4>{t('review.conflicts')}</h4>
          <ul>
            {panel.conflicts.map((c, i) => (
              <li key={`${String(i)}:${c.imageIds.join(',')}`}>
                {c.reason} <small>{c.imageIds.join(', ')}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ComponentTree
        model={model}
        selected={panel.selected}
        hidden={panel.hidden}
        locked={locked}
        onSelect={panel.onSelect}
        onToggle={panel.onToggle}
        onStatus={panel.onStatus}
        onRemove={panel.onRemove}
        onAdd={panel.onAdd}
      />

      {selected && (
        <ComponentCard
          key={selected.id}
          assembly={selected}
          evidence={{
            thumbnails: panel.thumbnails,
            ...(panel.scale ? { scale: panel.scale } : {}),
          }}
          locked={locked}
          onField={(key, value) => {
            panel.onField(selected.id, key, value);
          }}
          onFocus={() => {
            panel.onFocus(selected.id);
          }}
        />
      )}

      <div className="mb-row">
        <button
          type="button"
          className={`btn sm${panel.stale ? ' primary' : ''}`}
          disabled={locked || !panel.stale}
          onClick={panel.onRebuild}
        >
          {t('review.rebuild')}
        </button>
        <span className="mb-hint">{t('review.rebuildHint')}</span>
      </div>

      {r && (
        <div
          className={`mb-cmp-note${clean ? '' : ' bad'}`}
          data-testid="build-report"
          role={clean ? 'status' : 'alert'}
        >
          <h4>{t('review.report')}</h4>
          {clean && <p>{t('review.reportOk')}</p>}
          {r.failed.length > 0 && (
            <>
              <p>{t('review.reportFailed')}</p>
              <ul>
                {r.failed.map((f) => (
                  <li key={f.id}>
                    <b>{f.id}</b> <small>{f.reason}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.simplified.length > 0 && (
            <>
              <p>{t('review.reportSimplified')}</p>
              <ul>
                {r.simplified.map((s) => (
                  <li key={s.id}>{t('review.reportLevel', { id: s.id, detail: s.detail })}</li>
                ))}
              </ul>
            </>
          )}
          {r.overBudget && <p>{t('review.reportOver')}</p>}
          {r.notes.map((n, i) => (
            <p key={`${String(i)}:${n}`}>
              <small>{n}</small>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
