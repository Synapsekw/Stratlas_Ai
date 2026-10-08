/**
 * The Designs panel (M11 G6, DSN-1 and DSN-2): the site's designs as a folder, file and layer tree
 * with visibility, entity counts, download the source, rename, archive and restore layers, clamp
 * linework, **Apply vertical offset** per surface layer and fly to. Alignment layers carry the
 * Alignments controls; the Compliance section sits below. Opened from the stage toolbar.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { DesignEntry, DesignLayer } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { PopTool } from '../workspace/StageTools';
import { ActiveAlignmentNote, AlignmentControls } from './Alignments';
import { ComplianceSection } from './Compliance';
import {
  designFileUrl,
  flyToLayer,
  importDesign,
  loadDesigns,
  patchDesign,
  patchLayer,
  useDesigns,
  watchImports,
} from './designsStore';

const KIND_LABEL: Record<DesignLayer['kind'], string> = {
  surface: 'Surface',
  linework: 'Linework',
  points: 'Points',
  alignment: 'Alignment',
};

/** `8 triangles, 9 vertices`. */
export function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n.toLocaleString('en')} ${n === 1 ? k.replace(/s$/, '') : k}`)
    .join(', ');
}

function OffsetEditor({
  design,
  layer,
  readOnly,
}: {
  design: DesignEntry;
  layer: DesignLayer;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(String(layer.verticalOffsetM));
  const [error, setError] = useState<string | null>(null);
  const v = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(v) && Math.abs(v) <= 1000;
  return (
    <label className="pop-row">
      <span>Vertical offset (m)</span>
      <input
        type="number"
        step="any"
        value={draft}
        disabled={readOnly}
        aria-label={`Vertical offset of ${layer.name} in metres`}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
      />
      <button
        type="button"
        disabled={readOnly || !valid || v === layer.verticalOffsetM}
        onClick={() => {
          void patchLayer(design.id, layer.id, { verticalOffsetM: v }).then(setError);
        }}
      >
        Apply vertical offset
      </button>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}

function LayerRow({
  design,
  layer,
  readOnly,
}: {
  design: DesignEntry;
  layer: DesignLayer;
  readOnly: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li
      data-testid={`design-layer-${layer.id}`}
      className={layer.archived ? 'is-archived' : undefined}
    >
      <div className="pop-row">
        <input
          type="checkbox"
          checked={layer.visible}
          disabled={readOnly || layer.archived}
          aria-label={`Show ${layer.name}`}
          onChange={() => {
            void patchLayer(design.id, layer.id, { visible: !layer.visible }).then(setError);
          }}
        />
        <span>
          <strong>{layer.name}</strong> {KIND_LABEL[layer.kind]}
          <br />
          <small>{countsText(layer.counts)}</small>
        </span>
        <button
          type="button"
          disabled={layer.archived}
          onClick={() => {
            void flyToLayer(design, layer).then(setError);
          }}
        >
          Fly to
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            void patchLayer(design.id, layer.id, { archived: !layer.archived }).then(setError);
          }}
        >
          {layer.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
      {!layer.archived && layer.kind === 'surface' && (
        <OffsetEditor design={design} layer={layer} readOnly={readOnly} />
      )}
      {!layer.archived && layer.kind === 'linework' && (
        <label className="pop-row">
          <input
            type="checkbox"
            checked={layer.clamp ?? false}
            disabled={readOnly}
            onChange={() => {
              void patchLayer(design.id, layer.id, { clamp: !(layer.clamp ?? false) }).then(
                setError,
              );
            }}
          />
          <span>Clamp to terrain</span>
        </label>
      )}
      {!layer.archived && layer.kind === 'alignment' && (
        <AlignmentControls design={design} layer={layer} readOnly={readOnly} />
      )}
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function DesignItem({
  design,
  projectId,
  readOnly,
}: {
  design: DesignEntry;
  projectId: string;
  readOnly: boolean;
}) {
  const [name, setName] = useState(design.name);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = design.layers.filter((l) => l.archived).length;
  const layers = design.layers.filter((l) => showArchived || !l.archived);
  return (
    <li data-testid={`design-${design.id}`}>
      <div className="pop-row">
        <input
          value={name}
          disabled={readOnly}
          aria-label="Design name"
          onChange={(e) => {
            setName(e.target.value);
          }}
          onBlur={() => {
            const n = name.trim();
            if (n && n !== design.name)
              void patchDesign(design.id, { name: n.slice(0, 200) }).then(setError);
            else setName(design.name);
          }}
        />
        <a
          href={designFileUrl(projectId, design.id, design.src)}
          download={design.src}
          title="Download the source file"
        >
          {design.src}
        </a>
      </div>
      <small>
        {design.format.toUpperCase()}, {design.units}
        {design.calibrated
          ? ', site calibration'
          : design.crs && 'epsg' in design.crs
            ? `, EPSG:${String(design.crs.epsg)}`
            : ''}
      </small>
      <ul>
        {layers.map((l) => (
          <LayerRow key={l.id} design={design} layer={l} readOnly={readOnly} />
        ))}
      </ul>
      {archived > 0 && (
        <button
          type="button"
          onClick={() => {
            setShowArchived(!showArchived);
          }}
        >
          {showArchived ? 'Hide archived layers' : `Show archived layers (${String(archived)})`}
        </button>
      )}
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function DesignsPanel() {
  const project = useWorkspace((s) => s.project);
  const file = useDesigns((s) => s.file);
  const error = useDesigns((s) => s.error);
  const busy = useDesigns((s) => s.busy);
  const [importError, setImportError] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  const readOnly = useAnnotateReadOnly();
  useEffect(() => {
    watchImports();
    if (projectId) void loadDesigns(projectId);
  }, [projectId]);
  if (!project) return null;
  const list = file?.designs ?? [];
  const folders = [...new Set(list.map((d) => d.folder ?? ''))].sort();
  return (
    <div className="pop-form" data-testid="designs-panel" aria-busy={busy}>
      <div className="pop-row">
        <strong>Designs</strong>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            void importDesign().then(setImportError);
          }}
        >
          Import design
        </button>
      </div>
      <ActiveAlignmentNote />
      {(error ?? importError) && (
        <p className="pop-note" role="alert">
          {error ?? importError}
        </p>
      )}
      {list.length === 0 && !busy && (
        <p className="pop-note">No designs yet. Import a LandXML, DXF, 12da or CSV design.</p>
      )}
      {folders.map((folder) => (
        <section key={folder || 'none'} aria-label={folder || 'Designs'}>
          {folder && <h4>{folder}</h4>}
          <ul>
            {list
              .filter((d) => (d.folder ?? '') === folder)
              .map((d) => (
                <DesignItem key={d.id} design={d} projectId={project.id} readOnly={readOnly} />
              ))}
          </ul>
        </section>
      ))}
      {list.length > 0 && <ComplianceSection designs={list} />}
    </div>
  );
}

/** The Designs button (in the Survey measurements popover). */
export function DesignsTool() {
  const hasProject = useWorkspace((s) => s.project !== null);
  return (
    <PopTool icon="layers" label="Designs" disabled={!hasProject} wide>
      <DesignsPanel />
    </PopTool>
  );
}
