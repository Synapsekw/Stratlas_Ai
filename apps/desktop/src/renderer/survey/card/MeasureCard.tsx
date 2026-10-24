/**
 * The one measurement card (volumetric parity W2), the same for every tool, in three places:
 *
 * - `live` while drawing: the header, the primary value and the secondary line;
 * - `detail` in the panel: every part, top to bottom (header, primary, secondary and "More",
 *   chips, chart, detail, actions);
 * - `report`: the header without controls, the primary, the secondary and the chart. It reads no
 *   store and draws no control, so `renderToStaticMarkup` prints it as it is.
 *
 * What it shows comes from `cardModel`; the chips, chart, detail and status are the caller's.
 */
import { Button, Chip, Icon, useT } from '@aio/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import { splitValue, type CardModel } from './cardModel';
import './card.css';

export type CardVariant = 'live' | 'detail' | 'report';

export interface CardSlots {
  /** The surface and date chips (`SurfaceChips`). */
  chips?: ReactNode;
  chart?: ReactNode;
  /** Vertices, the vertex table, template fields, calculators, material. */
  detail?: ReactNode;
  /** One status line under the values (stale, carried from an earlier version, computing). */
  status?: ReactNode;
}

/** The longest name a measurement takes (`SurveyMeasurement.label`). */
export const NAME_MAX = 200;

export function MeasureCard(p: {
  model: CardModel;
  variant: CardVariant;
  slots?: CardSlots;
  onRename?: (name: string) => void;
  /** The actions row (`CardActions`), in the detail variant. */
  actions?: ReactNode;
  /** The overflow menu at the end of the header (`CardMenu`), in the live and detail variants. */
  menu?: ReactNode;
  testId?: string;
  /**
   * The saved measurement the card shows (`data-measure-id`): its chart is then the one the PNG
   * export saves. Absent on a card of a measurement still being drawn.
   */
  measureId?: string;
}): ReactElement {
  const { model, variant } = p;
  const slots = p.slots ?? {};
  const report = variant === 'report';
  const detail = variant === 'detail';
  // a live card sits in a pile row (a button) beside the detail card of the same name: no landmark
  const Box = variant === 'live' ? 'div' : 'section';
  return (
    <Box
      className="mc"
      data-variant={variant}
      data-testid={p.testId ?? 'measure-card'}
      data-measure-id={p.measureId}
      aria-label={variant === 'live' ? undefined : model.name}
    >
      <header className="mc-head">
        <span className="mc-icon">
          <Icon name={model.icon} size={16} label={model.tool} />
        </span>
        {p.onRename && !report ? (
          <NameField name={model.name} onRename={p.onRename} />
        ) : (
          <h3 className="mc-name" data-testid="card-name">
            {model.name}
          </h3>
        )}
        {model.scope && (
          <span className="mc-scope" data-testid="card-scope">
            <Chip kind="tag">{model.scope.label}</Chip>
          </span>
        )}
        <Swatch colour={model.colour} name={model.colourName} />
        {!report && p.menu}
      </header>
      <Primary primary={model.primary} />
      {model.secondary !== '' && (
        <p className="mc-secondary" data-testid="card-secondary">
          {model.secondary}
        </p>
      )}
      {/* a figure never shows without its status: the live card too */}
      {slots.status && <div className="mc-status">{slots.status}</div>}
      {detail && model.more.length > 0 && <More rows={model.more} />}
      {detail && slots.chips && <div className="mc-chips">{slots.chips}</div>}
      {(detail || report) && slots.chart && <div className="mc-chart">{slots.chart}</div>}
      {detail && slots.detail && <div className="mc-detail">{slots.detail}</div>}
      {detail && p.actions && <div className="mc-actions">{p.actions}</div>}
    </Box>
  );
}

function Primary({ primary }: { primary: CardModel['primary'] }) {
  if (!primary) return null;
  const { figure, status } = splitStatus(primary.text);
  const { value, unit } = splitValue(figure);
  return (
    <p className="mc-primary" data-testid="card-primary">
      <span className="mc-value">{value}</span>
      {unit && <span className="mc-unit">{unit}</span>}
      <span className="mc-what">{primary.label}</span>
      {status && (
        <span className="mc-figure-status" data-testid="card-status">
          <Chip kind="status">{status}</Chip>
        </span>
      )}
    </p>
  );
}

/**
 * A figure and its status ("3 482.0 m³ (Stale, recompute)": the readout's note on the headline,
 * carried, stale, partial), so the status shows as a chip on every card, the live one too.
 */
function splitStatus(text: string): { figure: string; status: string | null } {
  const at = /^(.*\d.*?)\s+\(([^()]+)\)$/.exec(text);
  return at ? { figure: at[1] ?? text, status: at[2] ?? null } : { figure: text, status: null };
}

function Swatch({ colour, name }: { colour: string; name: string }) {
  const t = useT();
  return (
    <span
      className="mc-swatch"
      role="img"
      aria-label={`${t('mcard.colour')}, ${name}`}
      data-testid="card-colour"
      // the measurement's own colour, as the 3D view and the map draw it
      style={{ background: colour }}
    />
  );
}

/** The name in place: Enter or leaving the field saves, Escape puts the name back. */
function NameField({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(name);
  // a new name from outside (this rename saved, an undo, the tree) starts a fresh draft; the field
  // stays mounted, so focus stays where the person left it
  const [shown, setShown] = useState(name);
  if (shown !== name) {
    setShown(name);
    setDraft(name);
  }
  const commit = () => {
    const next = draft.trim().slice(0, NAME_MAX);
    if (next === '') setDraft(name);
    else if (next !== name) onRename(next);
  };
  return (
    <input
      className="mc-name mc-name-field"
      type="text"
      value={draft}
      maxLength={NAME_MAX}
      aria-label={t('mcard.rename')}
      data-testid="card-name"
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(name);
        }
      }}
      onBlur={commit}
    />
  );
}

/** "More": the full readout table, folded away until asked for. */
function More({ rows }: { rows: CardModel['more'] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="quiet"
        className="mc-more"
        icon={open ? 'chevup' : 'chevdown'}
        aria-expanded={open}
        data-testid="card-more"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t('mcard.more')}
      </Button>
      {open && (
        <table className="mc-readout" data-testid="card-readout">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
