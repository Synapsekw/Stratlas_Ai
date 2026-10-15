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
import { loadDetections, useDetections } from '../../detections/store';
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
  // the detection review of this project, or null while it is not read yet (usage unknown)
  const loaded = useDetections((s) =>
    s.projectId !== null && s.projectId === project?.id && !s.loading ? s.review.detections : null,
  );
  const projectId = project?.id ?? null;
  // Settings may be the first screen opened: read the review so delete counts its detections
  useEffect(() => {
    if (projectId) void loadDetections(projectId);
  }, [projectId]);
  const pkg = useShell((s) => s.pkg);
  const annotateReadOnly = useAnnotateReadOnly();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  if (!project) return <p className="help">{t('classes.noProject')}</p>;
  const readOnly = pkg || annotateReadOnly ? t('classes.readOnly') : null;
  const models = project.manifest.severityModels;
  const usageKnown = loaded !== null;
  const rows = classRows(project.manifest.classCatalogues, models, issues, loaded ?? NO_DETECTIONS);
  // the dialog shows the class as it is now (an undo or a reload may change its usage)
  const deleting = deletingId === null ? null : (rows.find((r) => r.cls.id === deletingId) ?? null);
  if (deletingId !== null && !deleting) setDeletingId(null);

  /** Run a store call for class `id`; its error shows under that row. Resolves to the error. */
  const run = async (id: string, p: Promise<string | null>): Promise<string | null> => {
    const e = await p;
    setErrors((prev) => {
      const rest = Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id));
      return e ? { ...rest, [id]: e } : rest;
    });
    return e;
  };
  /** Delete class `id`; focus stays in the panel so Ctrl+Z undoes it at once. */
  const remove = (id: string, to: string | null) => {
    void run(id, deleteClass(id, to)).then(() => {
      panel.current?.focus();
    });
  };

  return (
    <div
      ref={panel}
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
            error={errors[r.cls.id] ?? null}
            onEdit={(patch) => run(r.cls.id, editClass(r.cls.id, patch))}
            onSave={() => void run(r.cls.id, saveToLibrary(r.cls))}
            onDelete={() => {
              // unknown usage (review still loading) asks too: the dialog waits for the counts
              if (!usageKnown || r.issues + r.detections > 0) setDeletingId(r.cls.id);
              else remove(r.cls.id, null);
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
          known={usageKnown}
          targets={moveTargets(rows, deleting.cls.id)}
          returnTo={() => panel.current}
          onCancel={() => {
            setDeletingId(null);
          }}
          onDelete={(to) => {
            setDeletingId(null);
            remove(deleting.cls.id, to);
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

  // the name being saved: Enter then blur must not save it twice
  const saving = useRef<string | null>(null);
  const commitName = () => {
    const next = name.trim();
    if (next === saving.current) return;
    if (!next || next === cls.label) {
      setName(cls.label);
      return;
    }
    saving.current = next;
    void onEdit({ label: next }).then((e) => {
      saving.current = null;
      if (e) setName(cls.label);
    });
  };
  const setKey = (v: string) => {
    setHotkey(v);
    if (v === (cls.hotkey ?? '')) return;
    void onEdit({ hotkey: v === '' ? null : v }).then((err) => {
      if (err) setHotkey(cls.hotkey ?? '');
    });
  };
  const locked = row.issues > 0;
  const lockId = `classes-lock-${cls.id}`;

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
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            // a key press replaces the hotkey wherever the caret is
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key.length === 1) {
              e.preventDefault();
              setKey(e.key.toLowerCase());
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              setKey('');
            }
          }}
          onChange={(e) => {
            // paste and input methods: the last character typed
            setKey(e.target.value.slice(-1).toLowerCase());
          }}
        />
      </span>
      <span role="cell" className="cls-sev">
        <select
          className="input"
          aria-label={t('classes.severity', { label: cls.label })}
          aria-describedby={locked ? lockId : undefined}
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
        {locked && (
          <span id={lockId} className="cls-lock">
            <Icon name="lock" size={12} />
            <span aria-hidden="true">{t('classes.severityLockedShort')}</span>
            <span className="sr-only">{t('classes.severityLocked')}</span>
          </span>
        )}
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

/**
 * Delete a class that something may use: waits while the detection review is read, moves what
 * uses the class to the picked one, and when it is the only class offers to create the target.
 */
function DeleteDialog({
  row,
  known,
  targets,
  returnTo,
  onDelete,
  onCancel,
}: {
  row: ClassRow;
  /** False while the detection review is still being read (counts unknown). */
  known: boolean;
  targets: readonly { id: string; label: string }[];
  returnTo: () => HTMLElement | null;
  /** Delete, moving what uses the class to `to` (null when nothing uses it). */
  onDelete: (to: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // the safe choice has focus first: Enter on a dialog that just opened deletes nothing
  useFocusTrap(ref, true, { onEscape: onCancel, returnTo, initial: () => keep.current });
  const label = row.cls.label;
  const title = t('classes.delete.title', { label });
  const used = row.issues + row.detections > 0;
  const to = targets.some((c) => c.id === picked) ? picked : (targets[0]?.id ?? null);
  const counts = {
    issues: t('classes.delete.issues', { count: row.issues }),
    detections: t('classes.delete.detections', { count: row.detections }),
    label,
  };
  let text: string;
  if (!known) text = t('classes.delete.checking', { label });
  else if (!used) text = t('classes.delete.unused', { label });
  else if (targets.length === 0) text = t('classes.delete.usedOnly', counts);
  else text = t('classes.delete.used', counts);
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
          <p id="classes-delete-text" style={{ margin: 0 }} aria-live="polite">
            {text}
          </p>
          {known && used && targets.length > 0 && (
            <select
              className="input"
              data-testid="classes-move-to"
              aria-label={t('classes.delete.pickTarget')}
              value={to ?? ''}
              onChange={(e) => {
                setPicked(e.target.value);
              }}
            >
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {known && used && targets.length === 0 && (
            <>
              <p className="help" style={{ margin: 0 }}>
                {t('classes.delete.only', { label })}
              </p>
              <div className="cls-new">
                <NewClassRow
                  onCreate={(name) => createClass(name)}
                  onCreated={(cls) => {
                    setPicked(cls.id);
                  }}
                  testId="classes-delete-new"
                />
              </div>
            </>
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
            disabled={!known || (used && !to)}
            onClick={() => {
              onDelete(used ? to : null);
            }}
          >
            <Icon name="trash" size={14} />
            {used || !known ? t('classes.delete.move') : t('classes.delete.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
