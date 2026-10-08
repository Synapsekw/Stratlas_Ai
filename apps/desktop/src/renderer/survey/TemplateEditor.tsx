/**
 * Measurement templates (M11 G3, data-conventions section 27): the project's templates and the
 * person's library. A template picks a tool, the result rows in order (drag and drop, or the
 * arrows), custom fields (text, number, dropdown), default comparison presets, a default style
 * and a description; a bookmark puts it on the toolbar. Industry sets come with G9.
 */
import {
  ComparisonPreset,
  MeasurementTool,
  type SurfaceRef,
  type SurveyTemplate,
} from '@aio/schema';
import {
  addComparison,
  addField,
  addItem,
  availableItems,
  cleanOptions,
  copyTemplate,
  ITEM_LABELS,
  moveItem,
  newTemplate,
  removeComparison,
  removeField,
  removeItem,
  setDescription,
  setStyle,
  templateProblems,
  TOOL_FAMILY,
  TOOL_LABELS,
  uniqueId,
  updateField,
} from '@aio/survey';
import { Icon, useFocusTrap } from '@aio/ui';
import { useRef, useState } from 'react';
import { MEASURE_COLOR } from './measureScene';
import { deleteTemplate, openDialog, saveTemplate, useMeasure } from './measureStore';

type Scope = 'project' | 'user';

/** Surfaces and bases a preset can name without a project's own surfaces (G4 adds the rest). */
const REFS: { id: string; label: string; ref: SurfaceRef }[] = [
  { id: 'current', label: 'Current survey', ref: { kind: 'current' } },
  { id: 'previous', label: 'Previous survey', ref: { kind: 'previous' } },
  { id: 'smart', label: 'Smart base (perimeter TIN)', ref: { kind: 'smart' } },
  { id: 'fit-plane', label: 'Best-fit plane base', ref: { kind: 'fit-plane' } },
  { id: 'perimeter-mean', label: 'Perimeter mean base', ref: { kind: 'perimeter-mean' } },
  {
    id: 'perimeter-min',
    label: 'Lowest perimeter point',
    ref: { kind: 'reference', mode: 'perimeter-min' },
  },
];

const refLabel = (r: SurfaceRef) =>
  REFS.find((x) => JSON.stringify(x.ref) === JSON.stringify(r))?.label ?? r.kind;

export function TemplateEditor() {
  const dialog = useMeasure((s) => s.dialog);
  const templates = useMeasure((s) => s.templates);
  const readOnly = useMeasure((s) => s.readOnly);
  const projectId = useMeasure((s) => s.projectId);
  const initialScope: Scope =
    dialog?.kind === 'templates' ? dialog.scope : projectId && !readOnly ? 'project' : 'user';
  const [scope, setScope] = useState<Scope>(initialScope);
  const [draft, setDraft] = useState<SurveyTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    openDialog(null);
  };
  useFocusTrap(ref, true, { onEscape: close });

  const file = scope === 'project' ? templates.project : templates.user;
  const list = file?.templates ?? [];
  const projectLocked = scope === 'project' && (readOnly || !projectId);
  const problems = draft ? templateProblems(draft) : [];

  const run = async (p: Promise<string | null>, after?: () => void) => {
    setBusy(true);
    const err = await p;
    setBusy(false);
    setError(err);
    if (!err) after?.();
  };

  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sv-tpl-title"
      data-testid="survey-templates"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sv-dialog sv-tpl">
        <header className="sv-head" role="none">
          <h2 id="sv-tpl-title">Measurement templates</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="sv-tpl-body">
          <nav className="sv-tpl-list" aria-label="Templates">
            <div className="seg" role="group" aria-label="Where the templates are kept">
              {(['project', 'user'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => {
                    setScope(s);
                    setDraft(null);
                    setError(null);
                  }}
                >
                  {s === 'project' ? 'This project' : 'My library'}
                </button>
              ))}
            </div>
            <ul>
              {list.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={draft?.id === t.id && !isNew ? 'true' : undefined}
                    data-testid={`survey-template-${t.id}`}
                    onClick={() => {
                      setDraft(t);
                      setIsNew(false);
                      setError(null);
                    }}
                  >
                    {t.bookmarked && <Icon name="flag" size={12} />}
                    <span>{t.name}</span>
                    <small className="faint">{TOOL_LABELS[t.tool]}</small>
                  </button>
                </li>
              ))}
              {list.length === 0 && <li className="small faint">No templates here yet.</li>}
            </ul>
            <button
              type="button"
              className="btn sm"
              disabled={projectLocked}
              data-testid="survey-template-new"
              onClick={() => {
                setDraft(
                  newTemplate(
                    'New template',
                    'distance',
                    list.map((t) => t.id),
                  ),
                );
                setIsNew(true);
                setError(null);
              }}
            >
              <Icon name="plus" size={12} /> New template
            </button>
          </nav>
          <div className="sv-tpl-edit">
            {!draft && (
              <p className="faint small">
                Pick a template to change it, or make a new one. Bookmarked templates show on the
                toolbar.
              </p>
            )}
            {draft && (
              <TemplateForm
                draft={draft}
                locked={projectLocked}
                onChange={(t) => {
                  setDraft(t);
                }}
              />
            )}
          </div>
        </div>
        {(problems.length > 0 || error) && (
          <ul className="sv-problems" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
            {error && <li>{error}</li>}
          </ul>
        )}
        <footer className="sv-foot" role="none">
          {draft && !isNew && (
            <>
              <button
                type="button"
                className="btn sm danger"
                disabled={busy || projectLocked}
                onClick={() => {
                  void run(deleteTemplate(scope, draft.id), () => {
                    setDraft(null);
                  });
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy || (scope === 'user' && (readOnly || !projectId))}
                onClick={() => {
                  const other: Scope = scope === 'project' ? 'user' : 'project';
                  const into =
                    other === 'project'
                      ? (templates.project ?? { schema: 'aio.survey-templates/1', templates: [] })
                      : templates.user;
                  const copied = copyTemplate(draft, into).templates.at(-1);
                  if (copied) void run(saveTemplate(other, copied));
                }}
              >
                {scope === 'project' ? 'Copy to my library' : 'Copy to this project'}
              </button>
            </>
          )}
          <span className="sv-grow" />
          <button type="button" className="btn sm ghost" onClick={close}>
            Close
          </button>
          {draft && (
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || problems.length > 0 || projectLocked}
              data-testid="survey-template-save"
              onClick={() => {
                // a new template takes its id from its name when it is first saved
                const t = isNew
                  ? {
                      ...draft,
                      id: uniqueId(
                        draft.name,
                        list.map((x) => x.id),
                        'template',
                      ),
                    }
                  : draft;
                void run(saveTemplate(scope, t), () => {
                  setDraft(t);
                  setIsNew(false);
                });
              }}
            >
              Save template
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function TemplateForm({
  draft: t,
  locked,
  onChange,
}: {
  draft: SurveyTemplate;
  locked: boolean;
  onChange: (t: SurveyTemplate) => void;
}) {
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<'text' | 'number' | 'dropdown'>('text');
  const [fieldOptions, setFieldOptions] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [cmpLabel, setCmpLabel] = useState('');
  const [cmpFrom, setCmpFrom] = useState('smart');
  const [cmpTo, setCmpTo] = useState('current');
  const missing = availableItems(t.tool).filter((k) => !t.items.includes(k));
  const preset = (() => {
    const from = REFS.find((r) => r.id === cmpFrom)?.ref;
    const to = REFS.find((r) => r.id === cmpTo)?.ref;
    if (!from || !to) return null;
    const p = ComparisonPreset.safeParse({
      ...(cmpLabel.trim() ? { label: cmpLabel.trim() } : {}),
      from,
      to,
      useDeadband: false,
    });
    return p.success ? p.data : null;
  })();

  return (
    <fieldset className="sv-form" disabled={locked}>
      <legend className="sr-only">Template</legend>
      <label className="sv-field">
        <span>Name</span>
        <input
          className="sv-input"
          value={t.name}
          data-testid="survey-template-name"
          onChange={(e) => {
            onChange({ ...t, name: e.target.value.slice(0, 120) });
          }}
        />
      </label>
      <label className="sv-field">
        <span>Tool</span>
        <select
          className="sv-input"
          value={t.tool}
          data-testid="survey-template-tool"
          onChange={(e) => {
            const tool = MeasurementTool.parse(e.target.value);
            const fresh = newTemplate(t.name, tool, []);
            onChange({
              ...t,
              tool,
              family: TOOL_FAMILY[tool],
              items: TOOL_FAMILY[tool] === t.family ? t.items : fresh.items,
            });
          }}
        >
          {MeasurementTool.options.map((tool) => (
            <option key={tool} value={tool}>
              {TOOL_LABELS[tool]}
            </option>
          ))}
        </select>
      </label>
      <label className="sv-field">
        <span>Description</span>
        <textarea
          className="sv-input"
          rows={2}
          value={t.description ?? ''}
          onChange={(e) => {
            onChange(setDescription(t, e.target.value));
          }}
        />
      </label>
      <div className="sv-row">
        <label className="sv-check">
          <input
            type="checkbox"
            checked={t.bookmarked === true}
            data-testid="survey-template-bookmark"
            onChange={(e) => {
              onChange({ ...t, bookmarked: e.target.checked });
            }}
          />
          Bookmark on the toolbar
        </label>
        <label className="sv-check">
          Colour
          <input
            type="color"
            value={t.style?.color ?? MEASURE_COLOR}
            onChange={(e) => {
              onChange(setStyle(t, { ...(t.style ?? {}), color: e.target.value }));
            }}
          />
        </label>
      </div>

      <fieldset className="sv-sub">
        <legend>Result rows</legend>
        <ol className="sv-items-order" aria-label="Result rows in order">
          {t.items.map((k, i) => (
            <li
              key={k}
              draggable
              onDragStart={() => {
                setDragFrom(i);
              }}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={() => {
                if (dragFrom !== null) onChange({ ...t, items: moveItem(t.items, dragFrom, i) });
                setDragFrom(null);
              }}
            >
              <Icon name="grip" size={12} />
              <span className="sv-grow">{ITEM_LABELS[k] ?? k}</span>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Move ${ITEM_LABELS[k] ?? k} up`}
                disabled={i === 0}
                onClick={() => {
                  onChange({ ...t, items: moveItem(t.items, i, i - 1) });
                }}
              >
                <Icon name="chevup" size={12} />
              </button>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Move ${ITEM_LABELS[k] ?? k} down`}
                disabled={i === t.items.length - 1}
                onClick={() => {
                  onChange({ ...t, items: moveItem(t.items, i, i + 1) });
                }}
              >
                <Icon name="chevdown" size={12} />
              </button>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove ${ITEM_LABELS[k] ?? k}`}
                onClick={() => {
                  onChange(removeItem(t, k));
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ol>
        {missing.length > 0 && (
          <select
            className="sv-input"
            aria-label="Add a result row"
            value=""
            onChange={(e) => {
              if (e.target.value) onChange(addItem(t, e.target.value));
            }}
          >
            <option value="">Add a row</option>
            {missing.map((k) => (
              <option key={k} value={k}>
                {ITEM_LABELS[k] ?? k}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="sv-sub">
        <legend>Custom fields</legend>
        {t.fields.map((f) => (
          <div key={f.id} className="sv-row sv-wrap" data-testid={`survey-template-field-${f.id}`}>
            <input
              className="sv-input"
              aria-label="Field name"
              value={f.name}
              onChange={(e) => {
                onChange(updateField(t, f.id, { name: e.target.value.slice(0, 80) }));
              }}
            />
            <select
              className="sv-input"
              aria-label={`${f.name} type`}
              value={f.type}
              onChange={(e) => {
                onChange(
                  updateField(t, f.id, { type: e.target.value as 'text' | 'number' | 'dropdown' }),
                );
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="dropdown">Dropdown</option>
            </select>
            {f.type === 'dropdown' && (
              <input
                className="sv-input sv-grow"
                aria-label={`${f.name} choices, separated by commas`}
                placeholder="Choices, separated by commas"
                defaultValue={(f.options ?? []).join(', ')}
                onBlur={(e) => {
                  onChange(
                    updateField(t, f.id, { options: cleanOptions(e.target.value.split(',')) }),
                  );
                }}
              />
            )}
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Remove the field ${f.name}`}
              onClick={() => {
                onChange(removeField(t, f.id));
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        <div className="sv-row sv-wrap">
          <input
            className="sv-input"
            placeholder="Field name"
            aria-label="New field name"
            data-testid="survey-field-name"
            value={fieldName}
            onChange={(e) => {
              setFieldName(e.target.value);
            }}
          />
          <select
            className="sv-input"
            aria-label="New field type"
            data-testid="survey-field-type"
            value={fieldType}
            onChange={(e) => {
              setFieldType(e.target.value as 'text' | 'number' | 'dropdown');
            }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="dropdown">Dropdown</option>
          </select>
          {fieldType === 'dropdown' && (
            <input
              className="sv-input sv-grow"
              placeholder="Choices, separated by commas"
              aria-label="New field choices, separated by commas"
              data-testid="survey-field-options"
              value={fieldOptions}
              onChange={(e) => {
                setFieldOptions(e.target.value);
              }}
            />
          )}
          <button
            type="button"
            className="btn sm"
            disabled={!fieldName.trim()}
            data-testid="survey-field-add"
            onClick={() => {
              onChange(addField(t, fieldName, fieldType, fieldOptions.split(',')));
              setFieldName('');
              setFieldOptions('');
            }}
          >
            Add field
          </button>
        </div>
      </fieldset>

      {t.family === 'polygon' && (
        <fieldset className="sv-sub">
          <legend>Comparisons</legend>
          <ul className="sv-cmp">
            {t.comparisons.map((c, i) => (
              <li key={`${String(i)}-${c.label ?? ''}`}>
                <b>{c.label ?? `Comparison ${String(i + 1)}`}</b>
                <span className="small faint">
                  {refLabel(c.from)} to {refLabel(c.to)}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label={`Remove ${c.label ?? `comparison ${String(i + 1)}`}`}
                  onClick={() => {
                    onChange(removeComparison(t, i));
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <div className="sv-row sv-wrap">
            <input
              className="sv-input"
              placeholder="Label"
              aria-label="Comparison label"
              value={cmpLabel}
              onChange={(e) => {
                setCmpLabel(e.target.value.slice(0, 120));
              }}
            />
            <select
              className="sv-input"
              aria-label="From"
              value={cmpFrom}
              onChange={(e) => {
                setCmpFrom(e.target.value);
              }}
            >
              {REFS.map((r) => (
                <option key={r.id} value={r.id}>
                  From: {r.label}
                </option>
              ))}
            </select>
            <select
              className="sv-input"
              aria-label="To"
              value={cmpTo}
              onChange={(e) => {
                setCmpTo(e.target.value);
              }}
            >
              {REFS.map((r) => (
                <option key={r.id} value={r.id}>
                  To: {r.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm"
              disabled={!preset}
              title={preset ? undefined : 'At least one side must be a survey'}
              data-testid="survey-comparison-add"
              onClick={() => {
                if (preset) onChange(addComparison(t, preset));
                setCmpLabel('');
              }}
            >
              Add comparison
            </button>
          </div>
        </fieldset>
      )}
    </fieldset>
  );
}
