/**
 * The request itself in the Ask panel: what to do (Find, Compare dates, Ask), the words, the
 * values to read and the class and severity a draft carries when accepted. The editor's state
 * turns into a saved `aio.ai-request/1` and back; scope, model and Run live in the panel.
 */
import {
  AI_REQUEST_SCHEMA,
  AiRequest,
  type AskKind,
  type AskModelChoice,
  type FieldSpec,
  type ProjectManifest,
} from '@aio/schema';
import { useT } from '@aio/ui';
import { useId, type ReactElement } from 'react';
import type { AskDraftRequest } from './custom';
import { FieldsEditor, fieldsProblem } from './FieldsEditor';

export type RequestWhere = 'project' | 'library';
export type FindScope = 'photo' | 'selected' | 'all';
export type Severity = number | 'uncertain';

export interface EditorState {
  /** Where the request was saved, and its id; absent for a new one. */
  saved?: { where: RequestWhere; id: string; createdAt: string };
  name: string;
  kind: AskKind;
  prompt: string;
  fields: FieldSpec[];
  /** A find's scope (a change looks at two dates, an ask at this photo). */
  scope: FindScope;
  model: AskModelChoice;
  classId: string | null;
  severity: Severity | null;
  wholeImage?: boolean;
}

export const emptyEditor = (): EditorState => ({
  name: '',
  kind: 'find',
  prompt: '',
  fields: [],
  scope: 'photo',
  model: 'auto',
  classId: null,
  severity: null,
});

const KINDS: readonly AskKind[] = ['find', 'change', 'ask'];

/** The request as a run takes it. */
export function draftRequest(s: EditorState, prompt = s.prompt): AskDraftRequest {
  const defaults = {
    ...(s.classId !== null ? { classId: s.classId } : {}),
    ...(s.severity !== null ? { severity: s.severity } : {}),
  };
  return {
    ...(s.saved ? { id: s.saved.id } : {}),
    name: s.name,
    kind: s.kind,
    prompt: prompt.trim(),
    fields: s.kind === 'ask' ? [] : s.fields.map((f) => ({ ...f })),
    ...(Object.keys(defaults).length > 0 && s.kind !== 'ask' ? { defaults } : {}),
    ...(s.wholeImage !== undefined ? { wholeImage: s.wholeImage } : {}),
  };
}

/** Why the request cannot be sent or saved yet; null when it can. */
export function editorProblem(
  s: EditorState,
  prompt = s.prompt,
): 'askPanel.note.empty' | 'askPanel.note.fields' | null {
  if (prompt.trim() === '') return 'askPanel.note.empty';
  if (s.kind !== 'ask' && fieldsProblem(s.fields)) return 'askPanel.note.fields';
  return null;
}

/** A new request id from its name: `pressure-gauges-1a2b3c`. */
export function requestId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug || 'request'}-${globalThis.crypto.randomUUID().slice(0, 6)}`;
}

/**
 * The request as saved: the same id when it is saved again under its name in the same place,
 * else a new one. Throws when it is not a valid request.
 */
export function toAiRequest(
  s: EditorState,
  o: { name: string; where: RequestWhere; author: string; now: string; prompt?: string },
): AiRequest {
  const name = o.name.trim().slice(0, 80);
  // saved again under its name in the same place: the same request
  const prev = s.saved?.where === o.where && s.name.trim() === name ? s.saved : undefined;
  const d = draftRequest(s, o.prompt ?? s.prompt);
  return AiRequest.parse({
    schema: AI_REQUEST_SCHEMA,
    id: prev ? prev.id : requestId(name),
    name,
    kind: s.kind,
    prompt: d.prompt.slice(0, 2000),
    fields: d.fields,
    scope: s.kind === 'change' ? 'dates' : s.kind === 'ask' ? 'photo' : s.scope,
    model: s.model,
    ...(d.defaults ? { defaults: d.defaults } : {}),
    ...(d.wholeImage !== undefined ? { wholeImage: d.wholeImage } : {}),
    author: o.author.slice(0, 120),
    createdAt: prev ? prev.createdAt : o.now,
    updatedAt: o.now,
  });
}

/** A saved request in the editor. */
export function fromAiRequest(r: AiRequest, where: RequestWhere): EditorState {
  return {
    saved: { where, id: r.id, createdAt: r.createdAt },
    name: r.name,
    kind: r.kind,
    prompt: r.prompt,
    fields: r.fields.map((f) => ({ ...f })),
    scope: r.scope === 'selected' || r.scope === 'all' ? r.scope : 'photo',
    model: r.model,
    classId: r.defaults?.classId ?? null,
    severity: r.defaults?.severity ?? null,
    ...(r.wholeImage !== undefined ? { wholeImage: r.wholeImage } : {}),
  };
}

/** The severities a draft of `classId` may carry: its model's levels, and Uncertain when it has one. */
function severitiesOf(
  manifest: ProjectManifest,
  classId: string | null,
): { value: Severity; label: string }[] {
  const cls = manifest.classCatalogues.flatMap((c) => c.classes).find((c) => c.id === classId);
  const model = manifest.severityModels.find((m) => m.id === cls?.severityModel);
  if (!model) return [];
  return [
    ...model.levels.map((l) => ({ value: l.value, label: `${String(l.value)} ${l.label}` })),
    ...(model.uncertain ? [{ value: 'uncertain' as const, label: model.uncertain.label }] : []),
  ];
}

export function RequestEditor({
  state,
  onChange,
  manifest,
  disabled = false,
}: {
  state: EditorState;
  onChange: (s: EditorState) => void;
  manifest: ProjectManifest;
  disabled?: boolean;
}): ReactElement {
  const t = useT();
  const id = useId();
  const set = (p: Partial<EditorState>) => {
    onChange({ ...state, ...p });
  };
  const classes = manifest.classCatalogues.flatMap((c) => c.classes);
  const severities = severitiesOf(manifest, state.classId);
  return (
    <>
      <div className="seg askp-kind" role="group" aria-label={t('askPanel.kind')}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={state.kind === k}
            data-testid={`ask-kind-${k}`}
            onClick={() => {
              set({ kind: k });
            }}
          >
            {t(`askPanel.kind.${k}`)}
          </button>
        ))}
      </div>

      {state.kind !== 'ask' && (
        <label className="askp-block">
          <span className="askp-label">{t('askPanel.prompt')}</span>
          <textarea
            className="input askp-text"
            data-testid="ask-prompt"
            rows={3}
            maxLength={2000}
            placeholder={t(
              state.kind === 'change' ? 'askPanel.prompt.change' : 'askPanel.prompt.placeholder',
            )}
            value={state.prompt}
            disabled={disabled}
            onChange={(e) => {
              set({ prompt: e.target.value });
            }}
          />
        </label>
      )}

      {state.kind !== 'ask' && (
        <section className="askp-block" aria-labelledby={`${id}-fields`}>
          <span className="askp-label" id={`${id}-fields`}>
            {t('askPanel.fields')}
          </span>
          {state.fields.length === 0 && (
            <span className="faint small">{t('askPanel.fields.hint')}</span>
          )}
          <FieldsEditor
            fields={state.fields}
            disabled={disabled}
            onChange={(fields) => {
              set({ fields });
            }}
          />
        </section>
      )}

      {state.kind !== 'ask' && (
        <section className="askp-block" aria-labelledby={`${id}-defaults`}>
          <span className="askp-label" id={`${id}-defaults`}>
            {t('askPanel.defaults')}
          </span>
          {/* each choice named beside its list, so the list shows its whole placeholder in a
              narrow panel (side by side it read "Class: Pick at acc") */}
          <div className="askp-pair">
            <label className="askp-sub" htmlFor={`${id}-def-class`}>
              {t('askPanel.defaults.class')}
            </label>
            <select
              id={`${id}-def-class`}
              className="input"
              data-testid="ask-default-class"
              value={state.classId ?? ''}
              disabled={disabled}
              onChange={(e) => {
                const classId = e.target.value === '' ? null : e.target.value;
                const keep = severitiesOf(manifest, classId).some(
                  (x) => x.value === state.severity,
                );
                set({ classId, severity: keep ? state.severity : null });
              }}
            >
              <option value="">{t('askPanel.defaults.none')}</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="askp-sub" htmlFor={`${id}-def-severity`}>
              {t('askPanel.defaults.severity')}
            </label>
            <select
              id={`${id}-def-severity`}
              className="input"
              data-testid="ask-default-severity"
              value={state.severity === null ? '' : String(state.severity)}
              disabled={disabled || severities.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                set({ severity: v === '' ? null : v === 'uncertain' ? v : Number(v) });
              }}
            >
              <option value="">{t('askPanel.defaults.none')}</option>
              {severities.map((s) => (
                <option key={String(s.value)} value={String(s.value)}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </section>
      )}
    </>
  );
}
