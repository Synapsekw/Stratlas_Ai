/**
 * The catalogue picker (spec D22): a modal launched from the antenna, radio or AAU field. Search,
 * a vendor filter and a "Supports <band>" filter over the catalogue the RF store holds; a list of
 * `Row`s (model, vendor, ports, gain or power, the bands, a verified mark); an `EmptyState` when
 * nothing matches; Import MSI (a pattern for the chosen antenna's port) and a catalogue file.
 * Not a permanent tab: it closes on Use, Cancel or Esc.
 */
import { BANDS, catalogueVendors, entryBandRanges, searchCatalogue, type Band } from '@aio/rf';
import type { RfCatalogueEntry } from '@aio/schema';
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  PortalRoot,
  Row,
  useFocusTrap,
  useT,
  type IconName,
} from '@aio/ui';
import { useMemo, useRef, useState } from 'react';
import { importCatalogue, useRf } from './rfStore';
import './rf.css';

export type PickKind = RfCatalogueEntry['kind'];

export interface CataloguePickerProps {
  /** The kinds offered, as the picker's own tabs; the first that is `initialKind` opens. */
  kinds: readonly PickKind[];
  initialKind?: PickKind;
  /** Band id from the band table (`bandOfName(carrier.band).id`) for the band filter; null: none. */
  band: string | null;
  /** The band as the carrier names it (B3, n78), for the filter's label; default the table's name. */
  bandName?: string | undefined;
  /** What the choice is for (a unit and its band), under the title. */
  context: string;
  /** The entry the field holds now. */
  selectedId?: string | undefined;
  /** Why an entry of this kind cannot be used now (a radio needs an antenna first). */
  blockedReason?: (kind: PickKind) => string | undefined;
  /** For Import MSI: the port of the chosen antenna a pattern is attached to. */
  portFor?: (entry: Extract<RfCatalogueEntry, { kind: 'antenna' }>) => string | undefined;
  onPick: (entry: RfCatalogueEntry) => void;
  onClose: () => void;
  /** The field that opened the picker (theme, and where focus goes back). */
  opener: HTMLElement | null;
}

const KIND_ICON: Readonly<Record<PickKind, IconName>> = {
  radio: 'telemetry',
  aau: 'box',
  antenna: 'target',
};

/** dBm to watts, rounded for a list. */
export function watts(dbm: number): string {
  const w = 10 ** ((dbm - 30) / 10);
  return w >= 10 ? w.toFixed(0) : w.toFixed(1);
}

/** The band table rows an entry covers. */
export function bandsOf(e: RfCatalogueEntry): Band[] {
  const ranges = entryBandRanges(e);
  return BANDS.filter((b) =>
    ranges.some(([lo, hi]) => hi >= b.dlRangeMHz[0] && lo <= b.dlRangeMHz[1]),
  );
}

/** The short name of a band row (n78, B3). */
export const bandShort = (b: Band): string => b.nrBand ?? `B${String(b.lteBands[0] ?? '')}`;

function EntryRow({
  entry,
  selected,
  band,
  onSelect,
  onUse,
}: {
  entry: RfCatalogueEntry;
  selected: boolean;
  band: string | null;
  onSelect: () => void;
  onUse: () => void;
}) {
  const t = useT();
  const bands = bandsOf(entry);
  const ports =
    entry.kind === 'antenna'
      ? t('rf.picker.ports', { count: entry.ports.length })
      : entry.kind === 'radio'
        ? t('rf.picker.txrx', { tx: entry.txPorts, rx: entry.rxPorts })
        : t('rf.picker.ports', { count: entry.ports });
  const power =
    entry.kind === 'antenna'
      ? t('rf.picker.gain', { dbi: Math.max(...entry.ports.map((p) => p.gainDbi)) })
      : entry.kind === 'radio'
        ? t('rf.picker.powerPort', { w: watts(entry.maxPowerDbmPerPort) })
        : t('rf.picker.powerTotal', { w: watts(entry.totalPowerDbm) });
  return (
    <Row
      kind="palette"
      as="button"
      className="rf-cat-row"
      icon={KIND_ICON[entry.kind]}
      selected={selected}
      aria-pressed={selected}
      data-testid={`rf-cat-${entry.id}`}
      onClick={onSelect}
      onDoubleClick={onUse}
      label={
        <span className="rf-cat-label">
          <span className="rf-cat-name">
            <b>
              {entry.vendor} {entry.model}
            </b>
            <span>{ports}</span>
          </span>
          <span className="rf-cat-bands">
            {bands.slice(0, 4).map((b) => (
              <Chip key={b.id} kind="tag" {...(b.id === band ? { tone: 'acc' as const } : {})}>
                {bandShort(b)}
              </Chip>
            ))}
            {bands.length > 4 && (
              <Chip kind="tag">{t('rf.picker.moreBands', { n: bands.length - 4 })}</Chip>
            )}
            {entry.verified ? (
              <Chip kind="tag" tone="acc">
                {t('rf.picker.verified')}
              </Chip>
            ) : (
              <Chip kind="tag" tone="warn">
                {t('rf.picker.unverified')}
              </Chip>
            )}
          </span>
        </span>
      }
      count={power}
    />
  );
}

export function CataloguePicker({
  kinds,
  initialKind,
  band,
  bandName,
  context,
  selectedId,
  blockedReason,
  portFor,
  onPick,
  onClose,
  opener,
}: CataloguePickerProps) {
  const t = useT();
  const all = useRf((s) => s.catalogue);
  const entries = useMemo(() => all.map((c) => c.entry), [all]);
  const [kind, setKind] = useState<PickKind>(
    initialKind && kinds.includes(initialKind) ? initialKind : (kinds[0] ?? 'antenna'),
  );
  const [text, setText] = useState('');
  const [vendors, setVendors] = useState<ReadonlySet<string>>(new Set());
  const [bandOnly, setBandOnly] = useState(band !== null);
  const [pick, setPick] = useState<string | null>(selectedId ?? null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useFocusTrap(dlg, true, {
    onEscape: onClose,
    initial: () => search.current,
    returnTo: () => opener,
  });

  const ofKind = useMemo(() => entries.filter((e) => e.kind === kind), [entries, kind]);
  const vendorList = useMemo(() => catalogueVendors(ofKind), [ofKind]);
  const list = useMemo(
    () =>
      searchCatalogue(ofKind, {
        text,
        ...(bandOnly && band !== null ? { band } : {}),
      }).filter((e) => vendors.size === 0 || vendors.has(e.vendor)),
    [ofKind, text, bandOnly, band, vendors],
  );
  const chosen = list.find((e) => e.id === pick) ?? null;
  const blocked = chosen ? blockedReason?.(chosen.kind) : undefined;
  const use = (e: RfCatalogueEntry | null) => {
    if (!e || blockedReason?.(e.kind)) return;
    onPick(e);
  };
  const clear = () => {
    setText('');
    setVendors(new Set());
    setBandOnly(false);
  };
  const runImport = async (format: 'msi' | 'catalogue') => {
    const attach =
      format === 'msi' && chosen?.kind === 'antenna'
        ? (() => {
            const portId = portFor?.(chosen) ?? chosen.ports[0]?.id;
            return portId === undefined ? undefined : { entryId: chosen.id, portId };
          })()
        : undefined;
    const r = await importCatalogue(
      format,
      {
        title: t(format === 'msi' ? 'rf.picker.importMsiTitle' : 'rf.picker.importFileTitle'),
        filterName: t(format === 'msi' ? 'rf.picker.msiFiles' : 'rf.picker.catalogueFiles'),
      },
      attach,
    );
    if (!r.ok && r.cancelled) return;
    if (!r.ok) setNote({ text: r.message || t('rf.picker.importFailed'), error: true });
    else
      setNote({
        text: [t('rf.picker.imported', { count: r.added }), ...r.warnings].join(' '),
        error: false,
      });
  };
  const kindLabel = (k: PickKind) => t(`rf.picker.kind.${k}`);
  const msiReason = chosen?.kind === 'antenna' ? undefined : t('rf.picker.importMsiNeedsAntenna');

  return (
    <PortalRoot opener={opener}>
      <div
        className="dlg-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={dlg}
          className="dlg wide rf-cat"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rf-cat-title"
          data-testid="rf-catalogue"
        >
          <div className="dlg-h">
            <h2 id="rf-cat-title">{t('rf.picker.title')}</h2>
            <span className="sub">{context}</span>
            <IconButton icon="x" label={t('rf.picker.close')} onClick={onClose} />
          </div>
          <div className="dlg-b rf-cat-body">
            {kinds.length > 1 && (
              <div className="seg rf-seg-full" role="group" aria-label={t('rf.picker.kinds')}>
                {kinds.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => {
                      setKind(k);
                      setVendors(new Set());
                    }}
                  >
                    {kindLabel(k)}
                  </button>
                ))}
              </div>
            )}
            <input
              ref={search}
              className="input rf-cat-search"
              type="search"
              value={text}
              placeholder={t('rf.picker.search')}
              aria-label={t('rf.picker.search')}
              autoComplete="off"
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
            <div className="rf-cat-filters" role="group" aria-label={t('rf.picker.filters')}>
              <span className="caps">{t('rf.picker.vendor')}</span>
              {vendorList.map((v) => (
                <Button
                  key={v}
                  pressed={vendors.has(v)}
                  onClick={() => {
                    const next = new Set(vendors);
                    if (next.has(v)) next.delete(v);
                    else next.add(v);
                    setVendors(next);
                  }}
                >
                  {v}
                </Button>
              ))}
              {band !== null && (
                <Button
                  pressed={bandOnly}
                  onClick={() => {
                    setBandOnly(!bandOnly);
                  }}
                >
                  {t('rf.picker.supports', {
                    band:
                      bandName ??
                      (() => {
                        const b = BANDS.find((x) => x.id === band);
                        return b ? bandShort(b) : band;
                      })(),
                  })}
                </Button>
              )}
            </div>
            <div
              className="rf-cat-list"
              aria-label={t('rf.picker.list', { kind: kindLabel(kind) })}
            >
              {list.length === 0 ? (
                <EmptyState
                  icon="search"
                  title={t('rf.picker.noneTitle')}
                  body={t('rf.picker.noneBody')}
                  action={<Button onClick={clear}>{t('rf.picker.clearFilters')}</Button>}
                />
              ) : (
                list.map((e) => (
                  <EntryRow
                    key={e.id}
                    entry={e}
                    band={band}
                    selected={pick === e.id}
                    onSelect={() => {
                      setPick(e.id);
                    }}
                    onUse={() => {
                      use(e);
                    }}
                  />
                ))
              )}
            </div>
            {note && (
              <p className={note.error ? 'rf-note rf-err' : 'rf-note'} role="status">
                {note.text}
              </p>
            )}
          </div>
          <div className="dlg-f">
            <span className="grow rf-cat-foot">{t('rf.picker.datasheetNote')}</span>
            <Button icon="import" disabledReason={msiReason} onClick={() => void runImport('msi')}>
              {t('rf.picker.importMsi')}
            </Button>
            <Button icon="import" onClick={() => void runImport('catalogue')}>
              {t('rf.picker.importFile')}
            </Button>
            <Button onClick={onClose}>{t('rf.picker.cancel')}</Button>
            <Button
              variant="primary"
              disabledReason={chosen ? blocked : t('rf.picker.chooseOne')}
              data-testid="rf-cat-use"
              onClick={() => {
                use(chosen);
              }}
            >
              {t(`rf.picker.use.${kind}`)}
            </Button>
          </div>
        </div>
      </div>
    </PortalRoot>
  );
}
