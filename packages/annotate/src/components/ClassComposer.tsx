import type { Issue, IssueClass, SeverityModel } from '@aio/schema';
import { useRef, useState } from 'react';
import { CLASS_PALETTE, nextClassColour } from '../model/palette';
import {
  generateSeverityModel,
  presetLevels,
  scalePresetName,
  type ScalePreset,
} from '../model/severityDraft';
import type { ClassCreator, SeverityCreator } from './NewClassRow';
import { sevStyle } from './common';

/**
 * Create a class from the sighting picker: name, colour, optional hotkey, and either a scale the
 * project already has or a new one generated as 1 to 3 or 1 to 5 (names editable before save).
 */
export function ClassComposer({
  classes,
  models,
  onCreateClass,
  onCreateModel,
  onCreated,
  onCancel,
}: {
  classes: readonly IssueClass[];
  models: readonly SeverityModel[];
  onCreateClass: ClassCreator;
  onCreateModel: SeverityCreator | null;
  onCreated: (cls: IssueClass) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(() => nextClassColour(classes.map((c) => c.color)));
  const [hotkey, setHotkey] = useState('');
  const [modelId, setModelId] = useState(models[0]?.id ?? 'new');
  const [preset, setPreset] = useState<ScalePreset>('3');
  const [scaleName, setScaleName] = useState(scalePresetName('3'));
  const [levels, setLevels] = useState(() => presetLevels('3'));
  const [uncertain, setUncertain] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = models.find((m) => m.id === modelId) ?? null;
  const making = modelId === 'new';
  const keyProblem = hotkeyProblem(hotkey, classes);

  const applyPreset = (next: ScalePreset) => {
    setPreset(next);
    setLevels(presetLevels(next));
    setScaleName(scalePresetName(next));
    setError(null);
  };

  const submit = async () => {
    if (busy || inFlight.current) return;
    const name = label.trim();
    if (!name) {
      setError('Type a name for the class.');
      return;
    }
    if (keyProblem) {
      setError(keyProblem);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let severityModel = chosen?.id ?? '';
      if (making) {
        if (!onCreateModel) {
          setError('This project cannot take a new severity scale.');
          return;
        }
        const scaleLabel = scaleName.trim();
        if (!scaleLabel) {
          setError('Type a name for the severity scale.');
          return;
        }
        if (models.some((m) => m.name.trim().toLowerCase() === scaleLabel.toLowerCase())) {
          setError(`A severity scale named ${scaleLabel} already exists.`);
          return;
        }
        if (levels.some((l) => !l.label.trim())) {
          setError('Each grade needs a name.');
          return;
        }
        const draft = generateSeverityModel(scaleLabel, preset, new Set(models.map((m) => m.id)));
        draft.levels = levels.map((l, i) => ({
          ...l,
          label: l.label.trim(),
          criteria: l.criteria.trim() || (draft.levels[i]?.criteria ?? ''),
        }));
        if (!uncertain) delete draft.uncertain;
        const saved = await onCreateModel(draft);
        severityModel = saved.id;
      }
      if (!severityModel) {
        setError('Pick a severity scale for the class.');
        return;
      }
      const key = hotkey.trim().toLowerCase();
      const cls = await onCreateClass(name, {
        color,
        severityModel,
        ...(key ? { hotkey: key } : {}),
      });
      onCreated(cls);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ann-pop-body" data-testid="picker-new-class">
        <div className="ann-pop-col">
          <div className="ann-pop-col-h">New class</div>
          <div className="ann-compose">
            <label className="ann-compose-field">
              <span>Name</span>
              <input
                className="ann-input"
                autoFocus
                aria-label="New class name"
                placeholder="Class name"
                maxLength={80}
                value={label}
                readOnly={busy}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    void submit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                  }
                }}
              />
            </label>
            <div className="ann-compose-field">
              <span>Colour</span>
              <div className="ann-swatches" role="group" aria-label="Class colour">
                {CLASS_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="ann-swatch"
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    aria-pressed={c.toLowerCase() === color.toLowerCase()}
                    disabled={busy}
                    onClick={() => {
                      setColor(c);
                    }}
                  />
                ))}
              </div>
            </div>
            <label className="ann-compose-field">
              <span>Hotkey</span>
              <input
                className="ann-input ann-hotkey"
                aria-label="Hotkey"
                placeholder="Optional"
                maxLength={1}
                value={hotkey}
                readOnly={busy}
                onChange={(e) => {
                  setHotkey(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 1));
                  setError(null);
                }}
              />
              <span className={keyProblem ? 'ann-error' : 'ann-faint'}>
                {keyProblem ?? 'One letter. a and u stay reserved, and digits pick a grade.'}
              </span>
            </label>
            <div className="ann-compose-field">
              <span>Severity scale</span>
              <div className="ann-scale" role="radiogroup" aria-label="Severity scale">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={modelId === m.id}
                    disabled={busy}
                    onClick={() => {
                      setModelId(m.id);
                      setError(null);
                    }}
                  >
                    <b>{m.name}</b>
                    <span>
                      {m.levels.length} {m.levels.length === 1 ? 'grade' : 'grades'}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={making}
                  disabled={busy || onCreateModel === null}
                  title={
                    onCreateModel === null ? 'A new scale cannot be saved from here.' : undefined
                  }
                  onClick={() => {
                    setModelId('new');
                    setError(null);
                  }}
                >
                  <b>New scale</b>
                  <span>Generate 1 to 3 or 1 to 5</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="ann-pop-col">
          <div className="ann-pop-col-h">
            {making ? 'New severity scale' : (chosen?.name ?? 'Severity')}
          </div>
          {making ? (
            <div className="ann-compose">
              <div className="ann-seg" role="group" aria-label="Generate a scale">
                <button
                  type="button"
                  aria-pressed={preset === '3'}
                  disabled={busy}
                  onClick={() => {
                    applyPreset('3');
                  }}
                >
                  1 to 3
                </button>
                <button
                  type="button"
                  aria-pressed={preset === '5'}
                  disabled={busy}
                  onClick={() => {
                    applyPreset('5');
                  }}
                >
                  1 to 5
                </button>
              </div>
              <label className="ann-compose-field">
                <span>Scale name</span>
                <input
                  className="ann-input"
                  aria-label="Severity scale name"
                  maxLength={80}
                  value={scaleName}
                  readOnly={busy}
                  onChange={(e) => {
                    setScaleName(e.target.value);
                    setError(null);
                  }}
                />
              </label>
              <div className="ann-grades">
                {levels.map((l, i) => (
                  <div key={l.value} className="ann-grade">
                    <span className="sw" style={sevStyle(l.color)}>
                      {l.value}
                    </span>
                    <input
                      className="ann-input"
                      aria-label={`Grade ${String(l.value)} name`}
                      value={l.label}
                      readOnly={busy}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLevels((prev) =>
                          prev.map((row, n) => (n === i ? { ...row, label: value } : row)),
                        );
                        setError(null);
                      }}
                    />
                    <input
                      className="ann-input crit"
                      aria-label={`Grade ${String(l.value)} criteria`}
                      value={l.criteria}
                      readOnly={busy}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLevels((prev) =>
                          prev.map((row, n) => (n === i ? { ...row, criteria: value } : row)),
                        );
                      }}
                    />
                  </div>
                ))}
              </div>
              <label className="ann-check">
                <input
                  type="checkbox"
                  checked={uncertain}
                  disabled={busy}
                  onChange={(e) => {
                    setUncertain(e.target.checked);
                  }}
                />
                Include uncertain
              </label>
            </div>
          ) : (
            <SeverityList model={chosen} severity={null} onPick={() => undefined} />
          )}
        </div>
      </div>
      {error && (
        <div className="ann-error ann-pop-error" role="alert">
          {error}
        </div>
      )}
      <div className="ann-pop-foot">
        <button type="button" className="ann-btn ghost" disabled={busy} onClick={onCancel}>
          Back
        </button>
        <button
          type="button"
          className="ann-btn primary"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? 'Saving...' : 'Create class'}
        </button>
      </div>
    </>
  );
}

/** Why a typed hotkey cannot be used, or null when it is empty or fine. */
function hotkeyProblem(hotkey: string, classes: readonly IssueClass[]): string | null {
  const k = hotkey.trim().toLowerCase();
  if (!k) return null;
  if (!/^[a-z]$/.test(k)) return 'A hotkey is one letter.';
  if (k === 'a' || k === 'u') return `"${k}" is reserved in the class picker.`;
  const other = classes.find((c) => c.hotkey?.toLowerCase() === k);
  return other ? `"${k}" is the hotkey of ${other.label}.` : null;
}

export function SeverityList({
  model,
  severity,
  onPick,
}: {
  model: SeverityModel | null;
  severity: Issue['severity'] | null;
  onPick: (v: Issue['severity']) => void;
}) {
  if (!model) {
    return <div className="ann-faint ann-pop-pad">This class has no severity scale.</div>;
  }
  const levels = [
    ...model.levels.map((l) => l.value),
    ...(model.uncertain ? (['uncertain'] as const) : []),
  ];
  return (
    <div className="sevs" role="group" aria-label="Severity">
      {levels.map((v) => {
        const level = v === 'uncertain' ? null : model.levels.find((l) => l.value === v);
        const label =
          v === 'uncertain' ? (model.uncertain?.label ?? 'Uncertain') : (level?.label ?? '');
        const criteria =
          v === 'uncertain' ? 'Not gradable from what is in view.' : (level?.criteria ?? '');
        const color =
          v === 'uncertain' ? (model.uncertain?.color ?? '#878d93') : (level?.color ?? '#878d93');
        return (
          <button
            key={String(v)}
            type="button"
            className={`sev-row${v === 'uncertain' ? ' unc' : ''}`}
            style={sevStyle(color)}
            aria-pressed={severity === v}
            onClick={() => {
              onPick(v);
            }}
          >
            <span className="sw">{v === 'uncertain' ? '?' : v}</span>
            <span className="lab">{label}</span>
            {criteria && <span className="crit">{criteria}</span>}
          </button>
        );
      })}
    </div>
  );
}
