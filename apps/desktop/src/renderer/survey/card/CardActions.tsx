/**
 * The card's controls (volumetric parity W2), the same on every measurement:
 *
 * - `CardMenu`, the "⋯" at the end of the header: exactly the measurement's right-click actions
 *   from the registry (rename, colour, hide, fly to, move, delete), plus Export;
 * - `CardActions`, the row at the foot of the detail card: Notes, Export and Fly to.
 *
 * "Add to report" joins both when the report templates land (Task 22).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import {
  actionsFor,
  Button,
  ContextMenu,
  IconButton,
  makeActionCtx,
  t,
  useT,
  type ResolvedItem,
} from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef, useState, type ReactElement } from 'react';
import { useShell } from '../../shell';
import { registerSidebarActions } from '../../shell/actions';
import { flyToMeasurement } from '../../shell/actions/measureActions';
import { toastHost } from '../../shell/actions/toastHost';
import { timeline } from '../../workspace/timeline';
import { openExportDialog } from '../ExportDialog';
import { patchMeasurement, select, updateMeasurement, useMeasure } from '../measureStore';
import './card.css';

/** The longest note a measurement keeps (`SurveyMeasurement.description`). */
export const NOTES_MAX = 4000;

/** Open the survey export with this measurement chosen. */
function exportOne(id: string): void {
  select([id], id);
  openExportDialog(true);
}

/** Whether the person may change this measurement here (not a package, not look-only). */
function useCanEdit(): boolean {
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  const readOnly = useMeasure((s) => s.readOnly);
  return !pkg && !lookOnly && !readOnly;
}

/** The "⋯" menu: the registry's measurement actions, then Export. */
export function CardMenu({ id }: { id: string }): ReactElement | null {
  const tr = useT();
  const opener = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const project = useWorkspace((s) => s.project);
  const hidden = useWorkspace((s) => s.hidden);
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  const label = useMeasure((s) => s.file.measurements.find((m) => m.id === id)?.label);
  if (!project || label === undefined) return null;
  const items = (): ResolvedItem[] => {
    registerSidebarActions();
    return [
      ...actionsFor(
        { kind: 'measurements', ids: [id], clicked: id },
        makeActionCtx({
          manifest: project.manifest,
          hidden,
          focus: timeline.getState().focus,
          pkg: !!pkg,
          canEdit: !pkg && !lookOnly,
          host: toastHost(label),
        }),
      ),
      {
        id: 'measure.export',
        label: t('mcard.export'),
        icon: 'download',
        section: 'file',
        disabled: pkg ? t('actions.reason.package') : false,
        shortcut: null,
        testId: 'card-menu-export',
        present: 'action',
        sub: [],
        subTitle: null,
        run: () => {
          exportOne(id);
        },
      },
    ];
  };
  return (
    <>
      <IconButton
        ref={opener}
        icon="more"
        label={tr('library.menu.button', { project: label })}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        data-testid="card-menu"
        onClick={() => {
          const r = opener.current?.getBoundingClientRect();
          setAt(at ? null : { x: r?.left ?? 0, y: r?.bottom ?? 0 });
        }}
      />
      {at && (
        <ContextMenu
          items={items()}
          x={at.x}
          y={at.y}
          label={label}
          title={label}
          testId="card-menu-list"
          onClose={() => {
            setAt(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The actions row: Notes (the measurement's description, edited in place), Export and Fly to.
 * `hasChart` marks a card whose export and report entry carry its chart (PNG; Task 22).
 */
export function CardActions(p: { id: string; hasChart: boolean }): ReactElement {
  const tr = useT();
  const canEdit = useCanEdit();
  const notes = useMeasure((s) => s.file.measurements.find((m) => m.id === p.id)?.description);
  const pkg = useShell((s) => s.pkg);
  const [open, setOpen] = useState(false);
  return (
    <div className="mc-act" data-testid="card-actions" data-has-chart={p.hasChart || undefined}>
      <div className="mc-act-row">
        <Button
          variant="quiet"
          icon="anno"
          pressed={open}
          data-testid="card-notes"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {tr('mcard.notes')}
        </Button>
        <Button
          variant="quiet"
          icon="download"
          data-testid="card-export"
          disabledReason={pkg ? tr('actions.reason.package') : undefined}
          onClick={() => {
            exportOne(p.id);
          }}
        >
          {tr('mcard.export')}
        </Button>
        <Button
          variant="quiet"
          icon="target"
          data-testid="card-fly"
          onClick={() => {
            flyToMeasurement(p.id);
          }}
        >
          {tr('mcard.flyTo')}
        </Button>
      </div>
      {open && (
        <NotesField
          key={notes ?? ''}
          id={p.id}
          initial={notes ?? ''}
          readOnly={!canEdit}
          label={tr('mcard.notes')}
        />
      )}
    </div>
  );
}

/** The note, saved when the field is left; an emptied note is removed. */
function NotesField(p: { id: string; initial: string; readOnly: boolean; label: string }) {
  const [draft, setDraft] = useState(p.initial);
  return (
    <textarea
      className="input mc-notes"
      value={draft}
      maxLength={NOTES_MAX}
      rows={3}
      readOnly={p.readOnly}
      aria-label={p.label}
      data-testid="card-notes-field"
      // a note is free text: the shortcuts of the view stay out of it
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
      }}
      onBlur={() => {
        const next = draft.trim();
        if (p.readOnly || next === p.initial.trim()) return;
        if (next === '')
          updateMeasurement(p.id, (m) => {
            const next = { ...m };
            delete next.description;
            return next;
          });
        else patchMeasurement(p.id, { description: next });
      }}
    />
  );
}
