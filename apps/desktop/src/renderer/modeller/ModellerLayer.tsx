import {
  drawingsOf,
  drawingToLocal,
  localToDrawing,
  ModelBuilder,
  type DrawingInfo,
  type DrawingPlacement,
} from '@aio/modelling';
import type { Vec3 } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseCoordinate } from '../builder/model';
import { hitLayer, useStagePick, usePickMarkers, type Marker } from '../builder/pick';
import { bridge, shell, useShell } from '../shell';
import { modeller, useModeller } from './index';
import './modeller.css';

const UNITS = [
  { value: '', label: 'As the file says' },
  { value: 'mm', label: 'Millimetres' },
  { value: 'cm', label: 'Centimetres' },
  { value: 'm', label: 'Metres' },
  { value: 'in', label: 'Inches' },
  { value: 'ft', label: 'Feet' },
  { value: 'us-ft', label: 'US survey feet' },
] as const;
type Units = Exclude<(typeof UNITS)[number]['value'], ''>;
const isUnits = (u: string): u is Units => UNITS.some((x) => x.value === u && u !== '');

/** Open the Model builder over the 3D view. */
export function openModelBuilder(): void {
  shell.getState().go('scene');
  void modeller.getState().show();
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [units, setUnits] = useState('');
  const pick = async () => {
    const r = await bridge.call('dialog:openFile', {
      title: 'Import a drawing',
      filters: [{ name: 'DXF drawing', extensions: ['dxf'] }],
    });
    if (r.ok && r.value.path) setSrc(r.value.path);
  };
  return (
    <div className="mb-form" aria-label="Import drawing">
      <div className="mb-row">
        <input
          type="text"
          aria-label="DXF file"
          placeholder="DXF file"
          value={src ?? ''}
          onChange={(e) => {
            setSrc(e.target.value);
          }}
        />
        <button type="button" className="btn ghost sm" onClick={() => void pick()}>
          Choose
        </button>
      </div>
      <label className="mb-field wide">
        <span>Drawing units</span>
        <select
          aria-label="Drawing units"
          value={units}
          onChange={(e) => {
            setUnits(e.target.value);
          }}
        >
          {UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mb-hint">DWG is not supported: save the drawing as DXF first.</p>
      <div className="mb-row">
        <button
          type="button"
          className="btn primary sm"
          disabled={!src}
          onClick={() => {
            if (!src) return;
            onDone();
            void modeller.getState().importDrawing({ src, ...(isUnits(units) ? { units } : {}) });
          }}
        >
          Import
        </button>
        <button type="button" className="btn ghost sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Pair {
  drawing: [number, number];
  local: Vec3;
}

/**
 * Place an imported drawing by two or more points: a point on the plan (clicked on the plan in
 * the 3D view, or typed in drawing units) and where it really is (clicked on the site, or typed as
 * easting and northing or latitude and longitude). Imports the drawing again with the control
 * points, which moves its plan, vectors and candidate parts.
 */
function PlaceDrawing({ drawing, onDone }: { drawing: DrawingInfo; onDone: () => void }) {
  const project = useWorkspace((s) => s.project);
  const [placement, setPlacement] = useState<DrawingPlacement | null>(null);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [armed, setArmed] = useState<'plan' | 'site' | null>(null);
  const [typedPlan, setTypedPlan] = useState('');
  const [typedSite, setTypedSite] = useState('');
  const [say, setSay] = useState<{ text: string; bad?: boolean }>({
    text: 'Pick a point on the plan, then where it is on the site. Two points or more.',
  });

  useEffect(() => {
    let live = true;
    modeller
      .getState()
      .placement(drawing)
      .then((p) => {
        if (live) setPlacement(p);
      })
      .catch((e: unknown) => {
        if (live) setSay({ text: e instanceof Error ? e.message : String(e), bad: true });
      });
    return () => {
      live = false;
    };
  }, [drawing]);

  // the plan must show to be picked
  useEffect(() => {
    workspace.getState().setLayerVisible(drawing.planLayer, true);
  }, [drawing.planLayer]);

  const origin = project?.manifest.origin;
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;

  const addSite = useCallback(
    (local: Vec3) => {
      if (!pending) return;
      setPairs((p) => [...p, { drawing: pending, local }]);
      setPending(null);
      setArmed(null);
      setSay({ text: 'Pair added. Pick the next point on the plan.' });
    },
    [pending],
  );

  useStagePick(armed !== null, (hit) => {
    if (!hit) {
      setSay({ text: 'Nothing under the cursor. Click the plan or the site.', bad: true });
      return;
    }
    if (armed === 'plan') {
      if (hitLayer(hit) !== drawing.planLayer || !placement) {
        setSay({ text: `That is not on the plan of ${drawing.name}. Click the plan.`, bad: true });
        return;
      }
      const d = localToDrawing(placement, [hit.point.x, hit.point.z]);
      if (!d) return;
      setPending(d);
      setArmed('site');
      setSay({ text: 'Now click where that point is on the site.' });
    } else if (armed === 'site') {
      if (hitLayer(hit) === drawing.planLayer) {
        setSay({
          text: 'That is the plan itself. Click the site (ortho, model or ground).',
          bad: true,
        });
        return;
      }
      addSite([hit.point.x, hit.point.y, hit.point.z]);
    }
  });

  const markers = useMemo<Marker[]>(() => {
    if (!placement) return [];
    const out: Marker[] = [];
    const at = (d: [number, number]): Vec3 => {
      const [x, z] = drawingToLocal(placement, d);
      return [x, placement.baseY + 0.05, z];
    };
    for (const p of pairs) {
      out.push({ pos: at(p.drawing), color: 0x60d3b2 });
      out.push({ pos: p.local, color: 0xf4b740 });
    }
    if (pending) out.push({ pos: at(pending), color: 0x60d3b2 });
    return out;
  }, [pairs, pending, placement]);
  usePickMarkers(markers);

  const typePlan = () => {
    const n = typedPlan
      .trim()
      .split(/[\s,;]+/)
      .map(Number);
    if (n.length !== 2 || n.some((v) => !Number.isFinite(v))) {
      setSay({ text: 'Type the drawing point as x y, in drawing units.', bad: true });
      return;
    }
    setPending([n[0] ?? 0, n[1] ?? 0]);
    setTypedPlan('');
    setArmed(null);
    setSay({ text: 'Now give where that point is on the site.' });
  };
  const typeSite = () => {
    if (!origin || epsg === null) {
      setSay({ text: 'This project has no coordinate system: click the site instead.', bad: true });
      return;
    }
    const enh = parseCoordinate(typedSite, epsg);
    if (!enh) {
      setSay({ text: 'Type easting northing, or latitude, longitude.', bad: true });
      return;
    }
    setTypedSite('');
    addSite([enh[0] - origin[0], enh[2] - origin[2], origin[1] - enh[1]]);
  };

  const place = () => {
    if (!project || pairs.length < 2) return;
    const units = placement?.units ?? '';
    onDone();
    void modeller.getState().importDrawing({
      src: `${project.root.replace(/\\/g, '/')}/${drawing.dxf}`,
      ...(isUnits(units) ? { units } : {}),
      control: pairs.map((p) => ({ drawing: p.drawing, local: p.local })),
    });
  };

  const f2 = (v: number) => v.toFixed(2);
  return (
    <div className="mb-form" aria-label={`Place ${drawing.name}`} data-testid="place-drawing">
      <p className={`mb-hint${say.bad ? ' bad' : ''}`} role="status">
        {say.text}
      </p>
      <div className="mb-row">
        <button
          type="button"
          className={`btn sm${armed === 'plan' ? ' primary' : ''}`}
          disabled={!placement}
          onClick={() => {
            setArmed(armed === 'plan' ? null : 'plan');
          }}
        >
          Pick on the plan
        </button>
        <input
          type="text"
          aria-label="Drawing point (x y)"
          placeholder="or type x y"
          value={typedPlan}
          onChange={(e) => {
            setTypedPlan(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') typePlan();
          }}
        />
      </div>
      <div className="mb-row">
        <button
          type="button"
          className={`btn sm${armed === 'site' ? ' primary' : ''}`}
          disabled={!pending}
          onClick={() => {
            setArmed(armed === 'site' ? null : 'site');
          }}
        >
          Pick on the site
        </button>
        <input
          type="text"
          aria-label="Site point (E N, or lat, lon)"
          placeholder="or type E N, or lat, lon"
          value={typedSite}
          disabled={!pending}
          onChange={(e) => {
            setTypedSite(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') typeSite();
          }}
        />
      </div>
      {pairs.length > 0 && (
        <table className="mb-pairs">
          <thead>
            <tr>
              <th>Drawing x, y</th>
              <th>Site x, z</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <tr key={i}>
                <td>
                  {f2(p.drawing[0])}, {f2(p.drawing[1])}
                </td>
                <td>
                  {f2(p.local[0])}, {f2(p.local[2])}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Remove pair ${String(i + 1)}`}
                    onClick={() => {
                      setPairs((ps) => ps.filter((_, k) => k !== i));
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mb-row">
        <button
          type="button"
          className="btn primary sm"
          disabled={pairs.length < 2}
          onClick={place}
        >
          Place the drawing
        </button>
        <button type="button" className="btn ghost sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The Model builder panel over the 3D view, when it is open. */
export function ModellerLayer() {
  const s = useModeller((x) => x);
  const screen = useShell((x) => x.screen);
  const project = useWorkspace((x) => x.project);
  const [form, setForm] = useState<{ kind: 'import' } | { kind: 'place'; stem: string } | null>(
    null,
  );
  const drawings = useMemo(() => drawingsOf(project?.manifest), [project?.manifest]);
  const clouds = useMemo(
    () =>
      (project?.manifest.layers ?? [])
        .filter((l) => l.kind === 'pointcloud')
        .map((l) => ({ id: l.id, name: l.name })),
    [project?.manifest],
  );
  if (!s.open || screen !== 'scene' || !project) return null;
  const placing = form?.kind === 'place' ? drawings.find((d) => d.stem === form.stem) : undefined;
  const st = modeller.getState();
  return (
    <ModelBuilder
      model={s.model}
      models={s.models}
      readOnly={s.readOnly}
      selected={s.selected}
      busy={s.busy}
      error={s.error}
      notice={s.notice}
      drawings={drawings}
      clouds={clouds}
      cloudDrawings={project.manifest.aiCloudDrawings === true}
      onClose={st.hide}
      onSelect={st.select}
      onOpenModel={(id) => void st.openModel(id)}
      onStatus={(ids, status) => void st.setStatus(ids, status)}
      onDimension={(id, key, value) => void st.editDimension(id, key, value)}
      onText={(id, key, value) => void st.editPart(id, { [key]: value === '' ? undefined : value })}
      onImport={() => {
        setForm({ kind: 'import' });
      }}
      onPlace={(stem) => {
        setForm({ kind: 'place', stem });
      }}
      onFromDrawing={(stem) =>
        void st.addFromDrawing(stem).then((r) => {
          if ('error' in r) modeller.setState({ error: r.error });
          else
            modeller.setState({
              notice: `${String(r.added.length)} draft part${r.added.length === 1 ? '' : 's'} from the drawing.`,
            });
        })
      }
      onFromCloud={(layer) => void st.fitCloud({ layer })}
      onPreview={() => void st.build(true)}
      onBuild={() => void st.build(false)}
      onCloudDrawings={(allow) => void st.setCloudDrawings(allow)}
      onDismiss={st.dismiss}
    >
      {form?.kind === 'import' && (
        <ImportForm
          onDone={() => {
            setForm(null);
          }}
        />
      )}
      {placing && (
        <PlaceDrawing
          key={placing.stem}
          drawing={placing}
          onDone={() => {
            setForm(null);
          }}
        />
      )}
    </ModelBuilder>
  );
}
