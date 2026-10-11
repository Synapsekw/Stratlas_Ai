/**
 * The form of one pipeline, as the pack takes it. Free (Settings, Advanced): the person picks the
 * pipeline and the project folder. `fixed`: one pipeline for the open project, given as `draft`,
 * with neither question.
 */
import { PIPELINES, type PipelineName } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { buildParams, FORMS, type Field, type JobDraft } from '../jobs';
import { bridge, jobs, useJobs } from '../shell';
import { groupedPipelines } from './pipelines';

const PIPELINE_AREAS = groupedPipelines(PIPELINES);

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `job-f-${field.key}`;
  if (field.kind === 'list') {
    const ticked = new Set(value.split(',').filter(Boolean));
    return (
      <div className="nj-field">
        <span id={`${id}-l`} className="nj-label">
          {field.label}
          {field.required && <span className="req"> required</span>}
        </span>
        <div className="nj-list" role="group" aria-labelledby={`${id}-l`}>
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="nj-tick">
              <input
                type="checkbox"
                checked={ticked.has(o.value)}
                onChange={(e) => {
                  const next = new Set(ticked);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  // in the order of the choices
                  onChange(
                    (field.options ?? [])
                      .map((x) => x.value)
                      .filter((v) => next.has(v))
                      .join(','),
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
        {field.help && <p className="nj-help">{field.help}</p>}
      </div>
    );
  }
  return (
    <div className="nj-field">
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="req"> required</span>}
      </label>
      {field.kind === 'select' ? (
        <select
          id={id}
          className="input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="nj-row">
          <input
            id={id}
            className={`input${field.kind === 'number' || field.kind === 'origin' ? '' : ' mono'}`}
            value={value}
            placeholder={field.placeholder}
            spellCheck={false}
            inputMode={field.kind === 'number' ? 'decimal' : undefined}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          {field.kind === 'folder' && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void bridge.call('dialog:openFolder', { title: field.label }).then((r) => {
                  if (r.ok && r.value.path) onChange(r.value.path);
                });
              }}
            >
              Choose
            </button>
          )}
          {(field.kind === 'file' || field.kind === 'files') && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const multi = field.kind === 'files';
                void bridge
                  .call('dialog:openFiles', {
                    title: field.label,
                    ...(field.filters ? { filters: field.filters } : {}),
                    multi,
                  })
                  .then((r) => {
                    if (r.ok && r.value.paths.length) onChange(r.value.paths.join('; '));
                  });
              }}
            >
              {t('jobs.chooseFile')}
            </button>
          )}
        </div>
      )}
      {field.help && <p className="nj-help">{field.help}</p>}
    </div>
  );
}

export function PipelineForm({
  draft,
  fixed = false,
  onClose,
  onStarted,
}: {
  draft?: JobDraft | null;
  /** One pipeline for one project (`draft`): no pipeline list, no project folder field. */
  fixed?: boolean;
  /** Shows a Close button and is called after a start. */
  onClose?: (() => void) | undefined;
  onStarted?: ((jobId: string) => void) | undefined;
}) {
  const projectRoot = useWorkspace((s) => s.project?.root);
  const projectType = useWorkspace((s) => s.project?.manifest.type);
  const runtime = useJobs((s) => s.runtime);
  const [pipeline, setPipeline] = useState<PipelineName>(
    draft?.pipeline ?? (projectType === 'inspection' ? 'inspection.run' : 'aik.cameras'),
  );
  const [project, setProject] = useState(draft?.project ?? projectRoot ?? '');
  const [values, setValues] = useState<Record<string, string>>(draft?.values ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = PIPELINES.find((p) => p.name === pipeline);

  const submit = async () => {
    if (!project.trim()) {
      setError('Choose the project folder the job writes into.');
      return;
    }
    const built = buildParams(pipeline, values);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    const err = await jobs
      .getState()
      .start({ pipeline, project: project.trim(), params: built.params });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    // the store selects the job it has just started
    const id = jobs.getState().selected;
    if (id) onStarted?.(id);
    onClose?.();
  };

  return (
    <form
      className="new-job"
      aria-label="Run a pipeline"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!fixed && (
        <>
          <div className="nj-field">
            <label htmlFor="job-pipeline">Pipeline</label>
            <select
              id="job-pipeline"
              className="input"
              value={pipeline}
              onChange={(e) => {
                setPipeline(e.target.value as PipelineName);
                setValues({});
                setError(null);
              }}
            >
              {PIPELINE_AREAS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.pipelines.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {info && <p className="nj-help">{info.description}</p>}
          </div>
          <FieldInput
            field={{
              key: 'project',
              label: 'Project folder',
              kind: 'folder',
              required: true,
              help: 'Outputs and the job folder (jobs\\<id>) are written here.',
            }}
            value={project}
            onChange={(v) => {
              setProject(v);
              setError(null);
            }}
          />
        </>
      )}
      {FORMS[pipeline].map((f) => (
        <FieldInput
          key={`${pipeline}-${f.key}`}
          field={f}
          value={values[f.key] ?? ''}
          onChange={(v) => {
            setValues({ ...values, [f.key]: v });
            setError(null);
          }}
        />
      ))}
      {error && (
        <p className="nj-err" role="alert">
          {error}
        </p>
      )}
      <div className="nj-acts">
        {onClose && (
          <button type="button" className="btn sm ghost" onClick={onClose}>
            Close
          </button>
        )}
        <button
          type="submit"
          className="btn sm primary"
          disabled={busy || runtime?.found === false}
          data-testid="job-start"
        >
          <Icon name="play" size={14} />
          {busy ? 'Starting' : fixed ? t('processing.dialog.start') : 'Start job'}
        </button>
      </div>
    </form>
  );
}
