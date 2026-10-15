import { CLASS_PALETTE, NewClassRow, useAnnotateReadOnly, type ClassPatch } from '@aio/annotate';
import type { IssueClass, SeverityModel } from '@aio/schema';
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import {
  createClass,
  deleteClass,
  editClass,
  redoClassEdit,
  saveToLibrary,
  undoClassEdit,
} from '../../classes/store';
import { useDetections } from '../../detections/store';
import { useShell } from '../../shell';
import { classRows, moveTargets, type ClassRow } from './classesView';
import './classes.css';

const NO_DETECTIONS: readonly { classId: string; status: string }[] = [];

/**
 * Settings, Classes (ANN-7): rename, recolour, hotkey, severity scale, delete (moving what uses
 * the class), save to the class library on this computer. Ctrl+Z and Ctrl+Y undo and redo here.
 */
export function Classes() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const detections = useDetections((s) =>
    s.projectId !== null && s.projectId === project?.id ? s.review.detections : NO_DETECTIONS,
  );
  const pkg = useShell((s) => s.pkg);
  const annotateReadOnly = useAnnotateReadOnly();
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<ClassRow | null>(null);

  if (!project) return <p className="help">{t('classes.noProject')}</p>;
  const readOnly = pkg || annotateReadOnly ? t('classes.readOnly') : null;
  const models = project.manifest.severityModels;
  const rows = classRows(project.manifest.classCatalogues, models, issues, detections);

  /** Run a store call for class `id`; its error shows under that row. Resolves to the error. */
  const run = async (id: string, p: Promise<string | null>): Promise<string | null> => {
    const e = await p;
    setError(e ? { id, text: e } : null);
    return e;
  };

  return (
    <div
      className="cls-ed"
      data-testid="classes-panel"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) return;
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          void undoClassEdit();
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          void redoClassEdit();
        }
      }}
    >
      {readOnly && (
        <p className="notice warn" role="status">
          <Icon name="warn" size={14} />
          <span>{readOnly}</span>
        </p>
      )}
      <div className="cls-grid" role="table" aria-label={t('settings.page.classes')}>
        <div className="cls-h" role="row">
          <span role="columnheader">{t('classes.col.colour')}</span>
          <span role="columnheader">{t('classes.col.name')}</span>
          <span role="columnheader">{t('classes.col.hotkey')}</span>
          <span role="columnheader">{t('classes.col.severity')}</span>
          <span role="columnheader" className="cls-num">
            {t('classes.col.issues')}
          </span>
          <span />
        </div>
        {rows.length === 0 && <p className="help cls-empty">{t('classes.empty')}</p>}
        {rows.map((r) => (
          <ClassRowView
            key={r.cls.id}
            row={r}
            models={models}
            disabled={readOnly !== null}
            error={error?.id === r.cls.id ? error.text : null}
            onEdit={(patch) => run(r.cls.id, editClass(r.cls.id, patch))}
            onSave={() => void run(r.cls.id, saveToLibrary(r.cls))}
            onDelete={() => {
              if (r.issues + r.detections > 0) setDeleting(r);
              else void run(r.cls.id, deleteClass(r.cls.id, null));
            }}
          />
        ))}
      </div>
      <div className="cls-new">
        <NewClassRow
          onCreate={(label) => createClass(label)}
          onCreated={() => undefined}
          disabledReason={readOnly}
          testId="classes-new"
        />
      </div>
      {deleting && (
        <DeleteDialog
          row={deleting}
          targets={moveTargets(rows, deleting.cls.id)}
          onCancel={() => {
            setDeleting(null);
          }}
          onMove={(to) => {
            const id = deleting.cls.id;
            setDeleting(null);
            void run(id, deleteClass(id, to));
          }}
        />
      )}
    </div>
  );
}

function ClassRowView({
  row,
  models,
  disabled,
  error,
  onEdit,
  onSave,
  onDelete,
}: {
  row: ClassRow;
  models: readonly SeverityModel[];
  disabled: boolean;
  error: string | null;
  onEdit: (patch: ClassPatch) => Promise<string | null>;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { cls } = row;
  const [name, setName] = useState(cls.label);
  const [hotkey, setHotkey] = useState(cls.hotkey ?? '');
  // an undo, a redo or a change elsewhere shows here too
  const [shown, setShown] = useState({ label: cls.label, hotkey: cls.hotkey });
  if (shown.label !== cls.label || shown.hotkey !== cls.hotkey) {
    setShown({ label: cls.label, hotkey: cls.hotkey });
    if (shown.label !== cls.label) setName(cls.label);
    if (shown.hotkey !== cls.hotkey) setHotkey(cls.hotkey ?? '');
  }

  const commitName = () => {
    const next = name.trim();
    if (!next || next === cls.label) {
      setName(cls.label);
      return;
    }
    void onEdit({ label: next }).then((e) => {
      if (e) setName(cls.label);
    });
  };
  const locked = row.issues > 0;

  return (
    <div className="cls-row" role="row" data-testid={`classes-row-${cls.id}`}>
      <span role="cell">
        <Swatch cls={cls} disabled={disabled} onPick={(color) => void onEdit({ color })} />
      </span>
      <span role="cell">
        <input
          className="input"
          aria-label={t('classes.name', { label: cls.label })}
          value={name}
          maxLength={80}
          disabled={disabled}
          dir="auto"
          onChange={(e) => {
            setName(e.target.value);
          }}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitName();
            } else if (e.key === 'Escape') {
              setName(cls.label);
            }
          }}
        />
      </span>
      <span role="cell">
        <input
          className="input mono cls-key"
          aria-label={t('classes.hotkey', { label: cls.label })}
          value={hotkey}
          maxLength={1}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => {
            e.currentTarget.select();
          }}
          onChange={(e) => {
            const v = e.target.value.slice(-1).toLowerCase();
            if (v === (cls.hotkey ?? '')) {
              setHotkey(v);
              return;
            }
            setHotkey(v);
            void onEdit({ hotkey: v === '' ? null : v }).then((err) => {
              if (err) setHotkey(cls.hotkey ?? '');
            });
          }}
        />
      </span>
      <span role="cell">
        <select
          className="input"
          aria-label={t('classes.severity', { label: cls.label })}
          value={cls.severityModel}
          disabled={disabled || locked}
          title={locked ? t('classes.severityLocked') : ''}
          onChange={(e) => {
            void onEdit({ severityModel: e.target.value });
          }}
        >
          {!models.some((m) => m.id === cls.severityModel) && (
            <option value={cls.severityModel}>{row.modelName}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </span>
      <span role="cell" className={`mono cls-num${row.issues === 0 ? ' faint' : ''}`}>
        {row.issues}
      </span>
      <span role="cell" className="cls-acts">
        <button
          type="button"
          className="btn ghost icon sm"
          data-testid={`classes-save-${cls.id}`}
          aria-label={`${t('classes.saveToLibrary')}: ${cls.label}`}
          title={t('classes.saveToLibrary')}
          onClick={onSave}
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm cls-del"
          data-testid={`classes-delete-${cls.id}`}
          aria-label={t('classes.delete', { label: cls.label })}
          title={t('classes.delete', { label: cls.label })}
          disabled={disabled}
          onClick={onDelete}
        >
          <Icon name="trash" size={14} />
        </button>
      </span>
      {error && (
        <p className="cls-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The colour of a class: a swatch that opens the class palette. */
function Swatch({
  cls,
  disabled,
  onPick,
}: {
  cls: IssueClass;
  disabled: boolean;
  onPick: (color: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('mousedown', away);
    };
  }, [open]);
  const label = t('classes.colour', { label: cls.label });
  const current = cls.color.toLowerCase();
  return (
    <span className="cls-sw-cell" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="cls-sw"
        style={{ background: cls.color }}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      />
      {open && (
        <span
          className="cls-palette"
          role="listbox"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          {CLASS_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c === current}
              aria-label={c}
              title={c}
              style={{ background: c }}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                if (c !== current) onPick(c);
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

function DeleteDialog({
  row,
  targets,
  onMove,
  onCancel,
}: {
  row: ClassRow;
  targets: readonly { id: string; label: string }[];
  onMove: (to: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  // the safe choice has focus first: Enter on a dialog that just opened deletes nothing
  useFocusTrap(ref, true, { onEscape: onCancel, initial: () => keep.current });
  const title = t('classes.delete.title', { label: row.cls.label });
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        className="dlg cls-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="classes-delete-title"
        aria-describedby="classes-delete-text"
        data-testid="classes-delete-dialog"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="classes-delete-title" dir="auto">
            {title}
          </h2>
        </div>
        <div className="dlg-b">
          <p id="classes-delete-text" style={{ margin: 0 }}>
            {t('classes.delete.used', {
              issues: row.issues,
              detections: row.detections,
              label: row.cls.label,
            })}
          </p>
          {targets.length > 0 ? (
            <select
              className="input"
              data-testid="classes-move-to"
              aria-label={t('classes.delete.pickTarget')}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
              }}
            >
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="help" style={{ margin: 0 }}>
              {t('classes.delete.pickTarget')}
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button ref={keep} type="button" className="btn ghost" onClick={onCancel}>
            {t('classes.delete.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            data-testid="classes-move-delete"
            disabled={!to}
            onClick={() => {
              onMove(to);
            }}
          >
            <Icon name="trash" size={14} />
            {t('classes.delete.move')}
          </button>
        </div>
      </div>
    </div>
  );
}
