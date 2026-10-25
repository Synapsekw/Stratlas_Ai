/**
 * The volumetric report's interactive view (D), the script inside the offline HTML file. It boots
 * from the JSON in `#vr-data` and draws into `#vr-app` (else the body): the band with the date,
 * view and unit toggles and the Save as PDF and Download CSV buttons; the map with numbered pile
 * buttons; the KPI tiles, the selected pile's card and the pile list. Bundled on its own (no
 * imports beyond this folder), plain DOM, every control a real `<button>`.
 */
import type { ViewerData, ViewerPile, ViewerStringKey, ViewerUnit, ViewerViewKind } from './types';

type Sort = 'volume' | 'change';

interface State {
  date: string;
  view: ViewerViewKind;
  unit: ViewerUnit;
  sort: Sort;
  selected: string | null;
}

export interface ViewerHandle {
  readonly root: HTMLElement;
  /** The current choices (a copy). */
  state(): Readonly<State>;
  select(pileId: string | null): void;
}

const UNIT_SUFFIX: Record<ViewerUnit, string> = { m3: 'm³', t: 't' };

/** An amount as the app formats volumes: thousands grouped, one decimal under 100, a minus if negative. */
export function formatAmount(value: number, unit: ViewerUnit): string {
  const v = Math.abs(value);
  const decimals = v >= 100 ? 0 : 1;
  const text = v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${value < 0 ? '−' : ''}${text} ${UNIT_SUFFIX[unit]}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(doc: Document, className: string, text: string): HTMLButtonElement {
  const b = el(doc, 'button', className, text);
  b.type = 'button';
  return b;
}

function readData(doc: Document): ViewerData | null {
  const block = doc.getElementById('vr-data');
  if (!block?.textContent) return null;
  try {
    const parsed = JSON.parse(block.textContent) as ViewerData;
    return Array.isArray(parsed.piles) && Array.isArray(parsed.dates) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The printed pages' pictures that the view also shows are held once, in the data block: each
 * such `<img data-vr-pic="kind:capture">` gets that picture's source here, so print shows it.
 */
export function fillSharedPictures(doc: Document, data: ViewerData): void {
  for (const img of doc.querySelectorAll<HTMLImageElement>('img[data-vr-pic]')) {
    const [kind, capture] = (img.dataset.vrPic ?? '').split(':');
    const pic = data.pictures.find((p) => p.kind === kind && p.capture === capture);
    if (pic) img.src = pic.src;
  }
}

/** Boots the view from the document's data block; null when there is none. */
export function bootViewer(doc: Document = document): ViewerHandle | null {
  const read = readData(doc);
  const lastDate = read?.dates[read.dates.length - 1];
  if (!read || !lastDate) return null;
  const data: ViewerData = read;
  fillSharedPictures(doc, data);
  const mount = doc.getElementById('vr-app') ?? doc.body;

  const s = (key: ViewerStringKey, vars: Record<string, string | number> = {}) =>
    ((data.strings as Partial<Record<ViewerStringKey, string>>)[key] ?? key).replace(
      /\{(\w+)\}/g,
      (m, name: string) => (name in vars ? String(vars[name]) : m),
    );
  const dateLabel = (id: string | null) => data.dates.find((d) => d.id === id)?.label ?? '';
  const to = data.dates.some((d) => d.id === data.to) ? data.to : lastDate.id;
  const from = data.from && data.from !== to ? data.from : null;

  const state: State = {
    date: to,
    view: 'photo',
    unit: 'm3',
    sort: 'volume',
    selected: [...data.piles].sort((a, b) => a.number - b.number)[0]?.id ?? null,
  };

  const amountOn = (p: ViewerPile, capture: string | null, unit = state.unit): number | null => {
    if (!capture) return null;
    const d = p.byDate.find((x) => x.capture === capture);
    return (unit === 'm3' ? d?.m3 : d?.t) ?? null;
  };
  const changeOf = (p: ViewerPile, unit = state.unit): number | null => {
    const a = amountOn(p, from, unit);
    const b = amountOn(p, to, unit);
    return a === null || b === null ? null : b - a;
  };
  const totalOn = (capture: string): number | null => {
    const xs = data.piles.map((p) => amountOn(p, capture)).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };
  const amountText = (v: number | null) =>
    v === null ? s('vreport.table.noTonnes') : formatAmount(v, state.unit);
  const changeText = (v: number | null) => {
    if (v === null) return '';
    if (Math.abs(v) < 0.05) return s('vreport.piles.same');
    return s(v < 0 ? 'vreport.piles.less' : 'vreport.piles.more', {
      volume: formatAmount(Math.abs(v), state.unit),
    });
  };
  const changeTone = (v: number | null) =>
    v === null || Math.abs(v) < 0.05 ? 'same' : v < 0 ? 'less' : 'more';
  const picture = (kind: ViewerViewKind, capture: string) =>
    data.pictures.find((p) => p.kind === kind && p.capture === capture) ??
    (kind === 'cutfill' ? data.pictures.find((p) => p.kind === 'cutfill') : undefined);

  const viewNames: Record<ViewerViewKind, string> = {
    photo: s('vreport.viewer.view.photo'),
    cutfill: s('vreport.viewer.view.cutFill'),
    elevation: s('vreport.viewer.view.elevation'),
    '3d': s('vreport.viewer.view.3d'),
  };

  // ---- Band ----
  const root = el(doc, 'div', 'vr-d');
  const band = el(doc, 'header', 'vr-d-band');
  const brand = el(doc, 'div', 'vr-d-brand');
  const lockup = el(doc, 'span', 'vr-d-lockup');
  lockup.innerHTML = data.lockupSvg;
  brand.append(lockup, el(doc, 'span', 'vr-d-divider'));
  const heading = el(doc, 'div', 'vr-d-heading');
  heading.append(el(doc, 'h1', '', data.title), el(doc, 'p', '', data.subtitle));
  brand.append(heading);
  const controls = el(doc, 'div', 'vr-d-controls');

  const toggles: { button: HTMLButtonElement; on: () => boolean }[] = [];
  function segment<V>(
    label: string,
    options: { value: V; text: string }[],
    set: (v: V) => void,
    get: () => V,
  ) {
    const group = el(doc, 'div', 'vr-d-seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const o of options) {
      const b = makeButton(doc, 'vr-d-seg-btn', o.text);
      b.addEventListener('click', () => {
        set(o.value);
        render();
      });
      toggles.push({ button: b, on: () => get() === o.value });
      group.append(b);
    }
    const wrap = el(doc, 'div', 'vr-d-seg-wrap');
    wrap.append(el(doc, 'span', 'vr-d-seg-label', label), group);
    controls.append(wrap);
  }
  segment(
    s('vreport.viewer.date'),
    data.dates.map((d) => ({ value: d.id, text: d.label })),
    (v) => (state.date = v),
    () => state.date,
  );
  segment<ViewerViewKind>(
    s('vreport.viewer.view'),
    (['photo', 'cutfill', 'elevation', '3d'] as const).map((v) => ({
      value: v,
      text: viewNames[v],
    })),
    (v) => (state.view = v),
    () => state.view,
  );
  segment<ViewerUnit>(
    s('vreport.viewer.units'),
    [
      { value: 'm3', text: s('vreport.viewer.units.m3') },
      { value: 't', text: s('vreport.viewer.units.t') },
    ],
    (v) => (state.unit = v),
    () => state.unit,
  );
  const actions = el(doc, 'div', 'vr-d-actions');
  const pdf = makeButton(doc, 'vr-d-btn vr-d-btn-primary', s('vreport.viewer.savePdf'));
  pdf.addEventListener('click', () => {
    (doc.defaultView ?? window).print();
  });
  const csv = makeButton(doc, 'vr-d-btn vr-d-btn-outline', s('vreport.viewer.csv'));
  csv.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([data.csv], { type: 'text/csv;charset=utf-8' }));
    const a = el(doc, 'a');
    a.href = url;
    a.download = data.csvName;
    a.hidden = true;
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  });
  actions.append(pdf, csv);
  controls.append(actions);
  band.append(brand, controls);

  // ---- Map ----
  const body = el(doc, 'main', 'vr-d-body');
  const mapCol = el(doc, 'section', 'vr-d-mapcol');
  const map = el(doc, 'div', 'vr-d-map');
  if (data.frame) map.style.aspectRatio = `${data.frame.widthPx} / ${data.frame.heightPx}`;
  const img = el(doc, 'img');
  img.decoding = 'async';
  const empty = el(doc, 'div', 'vr-d-map-empty', s('vreport.pictures.placeholder'));
  const markers = el(doc, 'div', 'vr-d-markers');
  const markerButtons = new Map<string, HTMLButtonElement>();
  for (const p of data.piles) {
    if (!p.marker || !data.frame) continue;
    const b = makeButton(doc, 'vr-d-marker', p.tag);
    b.setAttribute('aria-label', s('vreport.viewer.select', { pile: p.label }));
    b.title = p.label;
    b.style.left = `${String(round((p.marker[0] / data.frame.widthPx) * 100))}%`;
    b.style.top = `${String(round((p.marker[1] / data.frame.heightPx) * 100))}%`;
    b.addEventListener('click', () => {
      select(p.id);
    });
    markerButtons.set(p.id, b);
    markers.append(b);
  }
  map.append(markers);
  const legend = el(doc, 'ul', 'vr-d-legend');
  for (const item of data.legend) {
    const li = el(doc, 'li');
    const sw = el(doc, 'span', 'vr-d-swatch');
    sw.style.background = item.colour;
    li.append(sw, el(doc, 'span', '', item.label));
    legend.append(li);
  }
  const caption = el(doc, 'p', 'vr-d-caption');
  mapCol.append(map, legend, caption);

  // ---- Side: KPIs, card, list ----
  const side = el(doc, 'aside', 'vr-d-side');
  const kpis = el(doc, 'div', 'vr-d-kpis');
  const kpi = (cls: string) => {
    const tile = el(doc, 'div', `vr-d-kpi ${cls}`);
    const label = el(doc, 'span', 'vr-d-kpi-label');
    const value = el(doc, 'span', 'vr-d-kpi-value');
    tile.append(label, value);
    kpis.append(tile);
    return { tile, label, value };
  };
  const total = kpi('vr-d-kpi-total');
  const change = kpi('vr-d-kpi-change');
  total.label.textContent = s('vreport.kpi.stock');
  change.label.textContent = s('vreport.kpi.change', { date: dateLabel(from) });
  change.tile.hidden = from === null;

  const card = el(doc, 'section', 'vr-d-card');
  card.setAttribute('aria-live', 'polite');

  const list = el(doc, 'section', 'vr-d-list');
  const listHead = el(doc, 'div', 'vr-d-list-head');
  const sorts = el(doc, 'div', 'vr-d-sorts');
  const sortButtons: { button: HTMLButtonElement; sort: Sort }[] = [];
  for (const [sort, key] of [
    ['volume', 'vreport.viewer.list.volume'],
    ['change', 'vreport.viewer.list.change'],
  ] as const) {
    const b = makeButton(doc, 'vr-d-sort', s(key));
    b.setAttribute('aria-label', s('vreport.viewer.sortBy', { column: s(key) }));
    b.addEventListener('click', () => {
      state.sort = sort;
      render();
    });
    sortButtons.push({ button: b, sort });
    sorts.append(b);
  }
  listHead.append(el(doc, 'h2', '', s('vreport.viewer.list')), sorts);
  const rowsBox = el(doc, 'div', 'vr-d-list-rows');
  const rows = new Map<
    string,
    { button: HTMLButtonElement; amount: HTMLElement; change: HTMLElement }
  >();
  for (const p of data.piles) {
    const b = makeButton(doc, 'vr-d-list-row', '');
    b.dataset.pile = p.id;
    const amount = el(doc, 'span', 'vr-d-row-amount');
    const ch = el(doc, 'span', 'vr-d-row-change');
    b.append(
      el(doc, 'span', 'vr-d-num', p.tag),
      el(doc, 'span', 'vr-d-row-name', p.label),
      amount,
      ch,
    );
    b.addEventListener('click', () => {
      select(p.id);
    });
    rows.set(p.id, { button: b, amount, change: ch });
  }
  list.append(listHead, rowsBox);
  if (data.piles.length > 0) side.append(kpis, card, list);
  else side.append(kpis, el(doc, 'p', 'vr-d-pick', s('vreport.viewer.pick')));
  body.append(mapCol, side);
  root.append(band, body);
  mount.append(root);

  function select(id: string | null) {
    state.selected = id;
    render();
  }

  function renderCard() {
    card.replaceChildren();
    const p = data.piles.find((x) => x.id === state.selected);
    if (!p) {
      card.append(el(doc, 'p', 'vr-d-pick', s('vreport.viewer.pick')));
      return;
    }
    const head = el(doc, 'div', 'vr-d-card-head');
    const h2 = el(doc, 'h2');
    h2.append(el(doc, 'span', 'vr-d-num', p.tag), doc.createTextNode(p.label));
    head.append(h2);
    const ch = changeOf(p);
    if (ch !== null) {
      const chip = el(doc, 'span', `vr-d-chip vr-d-${changeTone(ch)}`, changeText(ch));
      head.append(chip);
    }
    card.append(head);

    const crops = el(doc, 'div', 'vr-d-crops');
    for (const [capture, key] of [
      [from, 'vreport.piles.before'],
      [to, 'vreport.piles.after'],
    ] as const) {
      if (!capture) continue;
      const fig = el(doc, 'figure', 'vr-d-crop');
      const box = el(doc, 'div', 'vr-d-crop-img');
      const pic = picture('photo', capture);
      if (pic && p.crop && data.frame) {
        const { widthPx: w, heightPx: h } = data.frame;
        const { x, y, size } = p.crop;
        box.style.backgroundImage = `url("${pic.src}")`;
        box.style.backgroundSize = `${String(round((w / size) * 100))}% ${String(round((h / size) * 100))}%`;
        const px = w > size ? (x / (w - size)) * 100 : 0;
        const py = h > size ? (y / (h - size)) * 100 : 0;
        box.style.backgroundPosition = `${String(round(px))}% ${String(round(py))}%`;
      } else {
        box.classList.add('vr-d-crop-none');
      }
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `${p.label}, ${dateLabel(capture)}`);
      fig.append(box, el(doc, 'figcaption', '', s(key, { date: dateLabel(capture) })));
      crops.append(fig);
    }
    card.append(crops);

    const amount = amountOn(p, state.date);
    const site = totalOn(state.date);
    const facts = el(doc, 'dl', 'vr-d-facts');
    const fact = (label: string, value: string) => {
      const row = el(doc, 'div');
      row.append(el(doc, 'dt', '', label), el(doc, 'dd', '', value));
      facts.append(row);
    };
    fact(
      state.unit === 'm3' ? s('vreport.viewer.list.volume') : s('vreport.viewer.units.t'),
      amountText(amount),
    );
    if (p.areaM2 !== null) fact(s('vreport.piles.footprint'), formatPlain(p.areaM2, 0));
    if (p.peakM !== null) fact(s('vreport.piles.peak'), formatPlain(p.peakM, 1));
    if (p.base !== '') fact(s('vreport.piles.base'), p.base);
    if (amount !== null && site)
      fact(s('vreport.piles.share'), `${String(Math.round((amount / site) * 100))} %`);
    card.append(facts);
    if (p.note) {
      const note = el(doc, 'p', 'vr-d-note');
      note.append(
        el(doc, 'strong', '', `${s('vreport.piles.note')}: `),
        doc.createTextNode(p.note),
      );
      card.append(note);
    }
  }

  function renderList() {
    const vol = (p: ViewerPile) => amountOn(p, state.date, 'm3');
    const sorted = [...data.piles].sort((a, b) => {
      const [x, y] =
        state.sort === 'volume' ? [vol(b), vol(a)] : [changeOf(a, 'm3'), changeOf(b, 'm3')];
      if (x === null && y === null) return a.number - b.number;
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y || a.number - b.number;
    });
    const focused = doc.activeElement;
    for (const p of sorted) {
      const row = rows.get(p.id);
      if (!row) continue;
      row.amount.textContent = amountText(amountOn(p, state.date));
      const ch = changeOf(p);
      row.change.textContent = changeText(ch);
      row.change.className = `vr-d-row-change vr-d-${changeTone(ch)}`;
      row.button.setAttribute('aria-pressed', String(state.selected === p.id));
      rowsBox.append(row.button);
    }
    if (
      focused instanceof HTMLElement &&
      rowsBox.contains(focused) &&
      doc.activeElement !== focused
    )
      focused.focus();
    for (const sb of sortButtons)
      sb.button.setAttribute('aria-pressed', String(state.sort === sb.sort));
  }

  function render() {
    for (const t of toggles) t.button.setAttribute('aria-pressed', String(t.on()));
    const pic = picture(state.view, state.date);
    const mapText = s('vreport.viewer.map', {
      view: viewNames[state.view],
      date: dateLabel(state.view === 'cutfill' && pic ? pic.capture : state.date),
    });
    if (pic) {
      if (img.getAttribute('src') !== pic.src) img.src = pic.src;
      img.alt = mapText;
      if (img.parentNode !== map) map.prepend(img);
      empty.remove();
    } else {
      img.remove();
      if (empty.parentNode !== map) map.prepend(empty);
    }
    root.dataset.view = state.view;
    markers.hidden = state.view === '3d' || !pic;
    for (const [id, b] of markerButtons)
      b.setAttribute('aria-pressed', String(state.selected === id));
    legend.hidden = state.view !== 'cutfill' || data.legend.length === 0;
    caption.textContent = mapText;

    total.value.textContent = amountText(totalOn(state.date));
    total.label.textContent = `${s('vreport.kpi.stock')}, ${dateLabel(state.date)}`;
    const changes = data.piles.map((p) => changeOf(p)).filter((x): x is number => x !== null);
    const siteChange = changes.length ? changes.reduce((a, b) => a + b, 0) : null;
    change.value.textContent =
      siteChange === null ? s('vreport.table.noTonnes') : changeText(siteChange);
    change.tile.dataset.tone = changeTone(siteChange);
    renderCard();
    renderList();
  }

  render();
  return {
    root,
    state: () => ({ ...state }),
    select,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatPlain(n: number, decimals: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

if (typeof document !== 'undefined' && document.getElementById('vr-data')) {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => bootViewer(document), { once: true });
  else bootViewer(document);
}
