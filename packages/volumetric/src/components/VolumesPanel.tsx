import type { VolumeBaseId } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useMemo } from 'react';
import { registerRows, sortRows, totals, type SortKey } from '../model/register';
import { useVolumetric, volumetric } from '../store';
import { f0, f1, sgn } from './format';
import { ProfileChart } from './ProfileChart';

const BASE_HELP: Record<VolumeBaseId, string> = {
  tin: 'Smooth surface interpolated from the toe (default)',
  plane: 'Plane fitted through the toe',
  avg: 'Flat at the mean toe height',
  low: 'Flat at the lowest toe point, always the largest figure',
};

const short = (label: string) => label.replace(/ 20\d\d$/, '');

function useBases() {
  return useVolumetric((s) => s.file?.bases ?? []);
}

function DateSeg() {
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const epoch = useVolumetric((s) => s.epoch);
  const surface = useVolumetric((s) => s.surface);
  return (
    <div className="seg vol-seg" role="group" aria-label="Survey date">
      {captures.map((c) => (
        <button
          key={c.epoch}
          type="button"
          aria-pressed={surface !== 'change' && c.epoch === epoch}
          title={c.label}
          onClick={() => {
            volumetric.getState().setSurface(surface === 'change' ? 'photo' : surface);
            volumetric.getState().setEpoch(c.epoch);
          }}
        >
          {short(c.label)}
        </button>
      ))}
    </div>
  );
}

export function BaseSelect({ compact }: { compact?: boolean }) {
  const bases = useBases();
  const base = useVolumetric((s) => s.base);
  return (
    <label className={`vol-base${compact ? ' compact' : ''}`}>
      <span>Base</span>
      <select
        aria-label="Base surface"
        value={base}
        onChange={(e) => {
          volumetric.getState().setBase(e.target.value as VolumeBaseId);
        }}
      >
        {bases.map((b) => (
          <option key={b.id} value={b.id} title={BASE_HELP[b.id]}>
            {b.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const COLS: { key: SortKey; label: string }[] = [
  { key: 'id', label: 'Pile' },
  { key: 'fill', label: 'Fill' },
  { key: 'cut', label: 'Cut' },
  { key: 'net', label: 'Net' },
  { key: 'change', label: 'Change' },
];

function Register() {
  const piles = useVolumetric((s) => s.piles);
  const epoch = useVolumetric((s) => s.epoch);
  const base = useVolumetric((s) => s.base);
  const sort = useVolumetric((s) => s.sort);
  const selected = useVolumetric((s) => s.selected);
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  const rows = useMemo(
    () => sortRows(registerRows(piles, epoch, base), sort.key, sort.dir),
    [piles, epoch, base, sort],
  );
  const tot = useMemo(() => totals(piles, epoch, base), [piles, epoch, base]);
  const change = useMemo(() => piles.reduce((a, p) => a + p.change.net, 0), [piles]);
  return (
    <section className="vol-sec" aria-label="Pile register">
      <div className="vol-row">
        <h3>Pile register</h3>
        <button
          type="button"
          className="btn sm"
          title="Export the register as CSV"
          onClick={() => {
            void volumetric.getState().exportCsv();
          }}
        >
          <Icon name="download" size={14} />
          CSV
        </button>
      </div>
      <div className="vol-row vol-ctl">
        <DateSeg />
        <BaseSelect />
      </div>
      <table className="vol-reg" data-testid="vol-register">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={
                  sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    volumetric.getState().setSort(c.key);
                  }}
                >
                  {c.label}
                  {sort.key === c.key && <i aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</i>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              data-pile={r.id}
              aria-selected={r.id === selected}
              className={r.present ? '' : 'absent'}
              tabIndex={0}
              onClick={() => {
                volumetric.getState().select(r.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') volumetric.getState().select(r.id);
              }}
            >
              <td className="id">
                {r.id}
                {r.edited && <span className="vol-ed" title="Boundary edited by hand" />}
              </td>
              <td>{f0(r.fill)}</td>
              <td>{f0(r.cut)}</td>
              <td className="net">{f0(r.net)}</td>
              <td
                className={
                  Math.abs(r.change) < 50 ? 'vol-flat' : r.change < 0 ? 'vol-cut' : 'vol-fill'
                }
              >
                {sgn(r.change)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{tot.piles}</td>
            <td>{f0(tot.fill)}</td>
            <td>{f0(tot.cut)}</td>
            <td className="net">{f0(tot.net)}</td>
            <td>{sgn(change)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="vol-note">
        m³. Change is measured surface to surface inside each pile&apos;s zone, first to last
        survey, ignoring height differences under {deadband.toFixed(2)} m. It does not depend on the
        base.
      </p>
    </section>
  );
}

function SiteSummary() {
  const file = useVolumetric((s) => s.file);
  const piles = useVolumetric((s) => s.piles);
  const base = useVolumetric((s) => s.base);
  const density = useVolumetric((s) => s.density);
  if (!file) return null;
  const first = file.captures[0];
  const last = file.captures.at(-1);
  const t1 = first ? totals(piles, first.epoch, base).net : 0;
  const t2 = last ? totals(piles, last.epoch, base).net : 0;
  return (
    <section className="vol-sec" aria-label="Stockpile inventory">
      <h3>Stockpile inventory</h3>
      <div className="vol-kpis">
        <div>
          <span>{first?.label}</span>
          <b>{f0(t1)} m³</b>
          <small>{f0(t1 * density)} t</small>
        </div>
        <div className="vol-hot">
          <span>{last?.label}</span>
          <b>{f0(t2)} m³</b>
          <small>{f0(t2 * density)} t</small>
        </div>
        <div className="vol-cut">
          <span>Moved out</span>
          <b>{f0(file.pileChange.cut)} m³</b>
          <small>surface to surface</small>
        </div>
        <div className="vol-fill">
          <span>Placed</span>
          <b>{f0(file.pileChange.fill)} m³</b>
          <small>surface to surface</small>
        </div>
      </div>
      <p className="vol-note">
        {piles.length} piles. Base: <b>{file.bases.find((b) => b.id === base)?.label}</b>. Tonnage
        at {density} t/m³.
      </p>
    </section>
  );
}

/** Cut and fill between the surveys: the whole yard, by pile, and the two ways to count it. */
function ChangeSummary() {
  const file = useVolumetric((s) => s.file);
  const piles = useVolumetric((s) => s.piles);
  const density = useVolumetric((s) => s.density);
  const rows = useMemo(() => [...piles].sort((a, b) => a.change.net - b.change.net), [piles]);
  if (!file) return null;
  const first = file.captures[0];
  const last = file.captures.at(-1);
  const sc = file.siteChange;
  const inv =
    (last ? totals(piles, last.epoch, file.defaultBase).net : 0) -
    (first ? totals(piles, first.epoch, file.defaultBase).net : 0);
  const mx = Math.max(1, ...rows.map((p) => Math.max(p.change.cut, p.change.fill)));
  const span = `${short(first?.label ?? '')} to ${short(last?.label ?? '')}`;
  return (
    <div data-testid="vol-change">
      <section className="vol-sec" aria-label="Cut and fill">
        <h3>Change {span}</h3>
        <div className="vol-kpis">
          <div className="vol-cut">
            <span>Cut</span>
            <b>{f0(sc.cut)} m³</b>
            <small>whole yard</small>
          </div>
          <div className="vol-fill">
            <span>Fill</span>
            <b>{f0(sc.fill)} m³</b>
            <small>whole yard</small>
          </div>
          <div className="vol-hot">
            <span>Net</span>
            <b>{sgn(sc.net)} m³</b>
            <small>{f0(sc.net * density)} t</small>
          </div>
          <div>
            <span>Deadband</span>
            <b>{file.deadbandM.toFixed(2)} m</b>
            <small>smaller changes ignored</small>
          </div>
        </div>
      </section>
      <section className="vol-sec" aria-label="Change by pile">
        <h3>By pile</h3>
        <div className="vol-chg" role="list">
          {rows.map((p) => (
            <button
              key={p.id}
              type="button"
              role="listitem"
              data-pile={p.id}
              onClick={() => {
                volumetric.getState().select(p.id);
              }}
            >
              <b>{p.id}</b>
              <span className="vol-cbar" aria-hidden>
                <i className="c" style={{ width: `${((p.change.cut / mx) * 50).toFixed(1)}%` }} />
                <i className="f" style={{ width: `${((p.change.fill / mx) * 50).toFixed(1)}%` }} />
              </span>
              <span
                className={`v ${p.change.net < -50 ? 'vol-cut' : p.change.net > 50 ? 'vol-fill' : 'vol-flat'}`}
              >
                {sgn(p.change.net)}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="vol-sec" aria-label="Two ways to count the change">
        <h3>Two ways to count the change</h3>
        <p className="vol-note">
          Surface to surface, the piles changed by <b>{sgn(file.pileChange.net)} m³</b>. Comparing
          the two inventories (
          {file.bases.find((b) => b.id === file.defaultBase)?.label.toLowerCase()} base) gives{' '}
          <b>{sgn(inv)} m³</b>.
        </p>
        <p className="vol-note">
          The gap is material dug from below the earlier toe line. An inventory only counts what
          stands above its base, so a pile cut back into the floor looks smaller than the material
          that actually left. Use surface to surface for what moved, and the inventory for what is
          on hand.
        </p>
      </section>
    </div>
  );
}

function PileDetail({ id }: { id: string }) {
  const s = useVolumetric((x) => x);
  const pile = s.piles.find((p) => p.id === id);
  if (!pile || !s.file) return null;
  const file = s.file;
  const i = s.piles.findIndex((p) => p.id === id);
  const prev = s.piles[(i - 1 + s.piles.length) % s.piles.length];
  const next = s.piles[(i + 1) % s.piles.length];
  const capture = file.captures.find((c) => c.epoch === s.epoch);
  const first = file.captures[0];
  const last = file.captures.at(-1);
  const ep = pile.epochs[s.epoch];
  const editing = s.edit?.pile === id ? s.edit : null;
  const live = editing?.live?.result;
  const cur = live ? live.volumes[s.base].net : ep?.volumes[s.base].net;
  const vols = ep ? file.bases.map((b) => ({ ...b, v: ep.volumes[b.id].net })) : [];
  const mx = Math.max(1, ...vols.map((v) => v.v));
  const mn = Math.min(...vols.map((v) => v.v));
  const c = pile.change;
  const net = (e: string | undefined) => (e ? (pile.epochs[e]?.volumes[s.base].net ?? 0) : 0);
  const edited = pile.edited.includes(s.epoch);
  const edit = s.edits.find((e) => e.pile === id && e.epoch === s.epoch);
  const auto = pile.auto[s.epoch];
  const recomputed = s.recomputed[id]?.[s.epoch]?.[s.base]?.net;
  const pill =
    Math.abs(c.net) < 50
      ? ['vol-flat', 'Stable']
      : c.net < 0
        ? ['vol-cut', 'Drawn down']
        : ['vol-fill', 'Built up'];
  const prof = s.pileProfile?.pile === id ? s.pileProfile.data : null;

  return (
    <div className="vol-detail" data-testid="vol-pile" data-pile={id}>
      <section className="vol-sec vol-nav">
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            volumetric.getState().select(null);
          }}
        >
          <Icon name="back" size={14} />
          All piles
        </button>
        <div className="vol-pn">
          <button
            type="button"
            className="btn sm"
            aria-label={`Previous pile, ${prev?.id ?? ''}`}
            onClick={() => {
              volumetric.getState().step(-1);
            }}
          >
            ‹ {prev?.id}
          </button>
          <b className="vol-pid">{id}</b>
          <button
            type="button"
            className="btn sm"
            aria-label={`Next pile, ${next?.id ?? ''}`}
            onClick={() => {
              volumetric.getState().step(1);
            }}
          >
            {next?.id} ›
          </button>
        </div>
      </section>
      <section className="vol-sec">
        <div className="vol-row">
          <h3>{capture?.label}</h3>
          <span className={`vol-pill ${pill[0] ?? ''}`}>{pill[1]}</span>
        </div>
        <div className="vol-row vol-ctl">
          <DateSeg />
          <BaseSelect />
        </div>
        {ep || live ? (
          <>
            <div className="vol-kpis">
              <div className="vol-hot">
                <span>Volume</span>
                <b data-testid="vol-net">{f0(cur)} m³</b>
                <small>{file.bases.find((b) => b.id === s.base)?.label}</small>
              </div>
              <div>
                <span>Tonnage</span>
                <b>{f0((cur ?? 0) * s.density)} t</b>
                <small>at {s.density} t/m³</small>
              </div>
              <div>
                <span>Footprint</span>
                <b>{f0(live?.areaM2 ?? ep?.areaM2)} m²</b>
                <small>top {f1(live?.topM ?? ep?.topM)} m</small>
              </div>
              <div>
                <span>Height</span>
                <b>{f1(live?.heightM ?? ep?.heightM)} m</b>
                <small>above base</small>
              </div>
            </div>
            <div className="vol-dens">
              <label htmlFor="vol-dens">Bulk density</label>
              <input
                id="vol-dens"
                type="number"
                min={0.5}
                max={3}
                step={0.05}
                defaultValue={s.density}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (v > 0 && v < 5) volumetric.getState().setDensity(v);
                }}
              />
              <span>t/m³, applies to every pile</span>
            </div>
          </>
        ) : (
          <p className="vol-note">Not present on this date.</p>
        )}
      </section>
      <section className="vol-sec">
        <div className="vol-row">
          <h3>Boundary</h3>
          <span className={`vol-pill ${edited ? 'edit' : 'vol-flat'}`}>
            {edited ? 'Edited' : 'Automatic'}
          </span>
        </div>
        {editing ? (
          <>
            <p className="vol-note">
              Editing the {short(capture?.label ?? '')} toe line. The volume updates when you let go
              of a point.
            </p>
            <ol className="vol-steps">
              <li>Drag a point to move it along the ground.</li>
              <li>Drag a small midpoint to add a point there.</li>
              <li>Click a point and press Delete, or right-click it, to remove it.</li>
              <li>Undo with Ctrl+Z. Save when the line sits on the toe.</li>
            </ol>
            <p className="vol-note">
              An edited line fits every base to all of its points. The automatic line skips toe
              stretches that lean on a wall or another pile, so the two can differ even before you
              move a point.
            </p>
          </>
        ) : (
          <>
            <p className="vol-note">
              {edited && edit
                ? `Corrected by hand on ${new Date(edit.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. The bases are fitted to the whole edited line.`
                : 'Detected automatically. If the toe line is wrong, correct it point by point in 3D.'}
            </p>
            <div className="vol-row vol-acts">
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  void volumetric.getState().startEdit();
                }}
              >
                <Icon name="polygon" size={14} />
                Edit boundary
              </button>
              {edited && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    void volumetric.getState().revert(id, s.epoch);
                  }}
                >
                  Revert to automatic
                </button>
              )}
            </div>
          </>
        )}
      </section>
      {ep && (
        <section className="vol-sec">
          <h3>Base surface</h3>
          <div className="vol-bars" role="group" aria-label="Base surface">
            {vols.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === s.base}
                title={BASE_HELP[b.id]}
                onClick={() => {
                  volumetric.getState().setBase(b.id);
                }}
              >
                <span>{b.label}</span>
                <span className="vol-bar">
                  <i style={{ width: `${((Math.max(0, b.v) / mx) * 100).toFixed(1)}%` }} />
                </span>
                <span className="v">{f0(b.v)}</span>
              </button>
            ))}
          </div>
          <dl className="vol-facts">
            <dt>Spread across bases</dt>
            <dd>
              {f0(mn)} to {f0(mx)} m³ (±{f0(((mx - mn) / 2 / ((mx + mn) / 2 || 1)) * 100)}%)
            </dd>
            <dt>Survey error</dt>
            <dd>±{f0(ep.surveyErrM3)} m³</dd>
            {edited ? (
              <>
                <dt>Automatic boundary gave</dt>
                <dd>{f0(auto?.volumes[s.base].net)} m³</dd>
              </>
            ) : (
              <>
                <dt>Toe on the yard floor</dt>
                <dd>{f0((ep.groundToeFrac ?? 0) * 100)}%</dd>
                <dt>Recomputed here</dt>
                <dd
                  data-testid="vol-recomputed"
                  title="From the 10 cm grids, in a background worker"
                >
                  {recomputed === undefined ? '·' : `${f0(recomputed)} m³`}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}
      <section className="vol-sec">
        <h3>
          Change {short(first?.label ?? '')} to {short(last?.label ?? '')}
        </h3>
        <dl className="vol-facts">
          <dt>Surface to surface, cut</dt>
          <dd className="vol-cut">{f0(c.cut)} m³</dd>
          <dt>Surface to surface, fill</dt>
          <dd className="vol-fill">{f0(c.fill)} m³</dd>
          <dt>Net</dt>
          <dd>
            <b>{sgn(c.net)} m³</b>
          </dd>
          <dt>Inventory difference</dt>
          <dd>{sgn(net(last?.epoch) - net(first?.epoch))} m³</dd>
        </dl>
        {prof ? (
          <>
            <ProfileChart
              s={prof.s}
              series={[
                { z: prof.z1, label: short(first?.label ?? ''), color: 'var(--fg-3)' },
                { z: prof.z2, label: short(last?.label ?? ''), color: 'var(--acc)' },
              ]}
              base={prof.base}
              deadband={file.deadbandM}
              label="Long section through the pile for both dates with the base line"
            />
            <p className="vol-note">
              Long section along the pile&apos;s main axis. Dashed line: the{' '}
              {file.bases.find((b) => b.id === s.base)?.label.toLowerCase()} base for{' '}
              {short(capture?.label ?? '')}.
            </p>
          </>
        ) : (
          <p className="vol-note">Loading the surface…</p>
        )}
      </section>
    </div>
  );
}

/** Right panel of a volumetric project: inventory, register, and the selected pile. */
export function VolumesPanel({ className }: { className?: string }) {
  const status = useVolumetric((s) => s.status);
  const error = useVolumetric((s) => s.error);
  const selected = useVolumetric((s) => s.selected);
  const surface = useVolumetric((s) => s.surface);
  if (status === 'loading' || status === 'idle')
    return (
      <div className={`vol-panel ${className ?? ''}`}>
        <p className="vol-note pad">Opening the volumes…</p>
      </div>
    );
  if (status === 'error')
    return (
      <div className={`vol-panel ${className ?? ''}`}>
        <p className="vol-note pad">The volumes could not be opened: {error}</p>
      </div>
    );
  if (status === 'none')
    return (
      <div className={`vol-panel ${className ?? ''}`}>
        <p className="vol-note pad">This project has no stockpile volumes.</p>
      </div>
    );
  return (
    <div className={`vol-panel ${className ?? ''}`} data-testid="vol-panel">
      {selected ? (
        <PileDetail id={selected} />
      ) : (
        <>
          {surface === 'change' ? <ChangeSummary /> : <SiteSummary />}
          <Register />
        </>
      )}
    </div>
  );
}
