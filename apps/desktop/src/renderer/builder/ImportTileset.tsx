/**
 * **Import 3D Tiles** (M10 G7 follow-up): pick the root `tileset.json` of another program's export
 * (Bentley, Pix4D, DJI Terra), give it a name and a credit line, and main checks and copies it into
 * the project (`tilesets:import`). A georeferenced export shows in the 3D view at once; one in a
 * local frame is listed hidden, as placing it on the map is not built yet.
 */
import type { TilesetEntry } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, shell } from '../shell';
import { rasterPacks } from '../workspace/siteTiles';

interface TilesetImportState {
  draft: { path: string; name: string; attribution: string } | null;
  busy: boolean;
  done: TilesetEntry | null;
  error: string | null;
}

const folderName = (p: string) => p.split(/[\\/]/).slice(-2, -1)[0] ?? '';

export const tilesetImport = createStore<TilesetImportState>()(() => ({
  draft: null,
  busy: false,
  done: null,
  error: null,
}));

/** Pick a root `tileset.json` and open the import card. */
export async function pickTileset(): Promise<void> {
  shell.getState().setPalette(false);
  const r = await bridge.call('dialog:openFile', {
    title: 'Import 3D Tiles: pick the root tileset.json',
    filters: [{ name: '3D Tiles', extensions: ['json'] }],
  });
  if (!r.ok) {
    tilesetImport.setState({ draft: null, done: null, error: r.error });
    return;
  }
  if (!r.value.path) return;
  tilesetImport.setState({
    draft: { path: r.value.path, name: folderName(r.value.path), attribution: '' },
    done: null,
    error: null,
  });
}

async function start(): Promise<void> {
  const { draft } = tilesetImport.getState();
  const project = workspace.getState().project;
  if (!draft || !project) return;
  tilesetImport.setState({ busy: true, error: null });
  const name = draft.name.trim();
  const attribution = draft.attribution.trim();
  const r = await bridge.call('tilesets:import', {
    projectId: project.id,
    path: draft.path,
    ...(name ? { name } : {}),
    ...(attribution ? { attribution } : {}),
  });
  const error = !r.ok ? r.error : !r.value.ok ? r.value.error : null;
  if (error !== null || !r.ok || !r.value.ok) {
    tilesetImport.setState({ busy: false, error });
    return;
  }
  tilesetImport.setState({ busy: false, draft: null, done: r.value.entry });
  // the site view reloads the project's tilesets
  rasterPacks.getState().refresh();
}

const close = () => {
  tilesetImport.setState({ draft: null, done: null, error: null, busy: false });
};

/** The import card, bottom right with the other import panels. */
export function TilesetImportCard() {
  const { draft, busy, done, error } = useStore(tilesetImport);
  const project = useWorkspace((s) => s.project);
  if (!draft && !done && !error) return null;
  return (
    <section className="b-import" aria-label="Import 3D Tiles" data-testid="tileset-import">
      <header role="none">
        <Icon name="import" size={14} />
        {done ? `Imported ${done.name}` : 'Import 3D Tiles'}
        <button type="button" className="btn ghost sm" disabled={busy} onClick={close}>
          {draft ? 'Cancel' : 'Close'}
        </button>
      </header>
      <div className="b-heights">
        {draft && (
          <>
            <p className="faint small mono">{draft.path}</p>
            <div className="b-heights-field">
              <label>
                Name
                <input
                  value={draft.name}
                  maxLength={200}
                  aria-label="Tileset name"
                  onChange={(e) => {
                    tilesetImport.setState({ draft: { ...draft, name: e.target.value } });
                  }}
                />
              </label>
              <label>
                Credit line
                <input
                  value={draft.attribution}
                  maxLength={500}
                  placeholder="The credit the export's owner asks for"
                  aria-label="Credit line"
                  onChange={(e) => {
                    tilesetImport.setState({ draft: { ...draft, attribution: e.target.value } });
                  }}
                />
              </label>
            </div>
            <p className="faint small">
              The folder is copied into {project?.manifest.name ?? 'the project'}. Only 3D Tiles 1.0
              and 1.1 with every file inside the folder are taken.
            </p>
          </>
        )}
        {done && (
          <p className="small" role="status">
            {done.visible
              ? 'It is placed by its own georeference and shows in the 3D view.'
              : 'It has no georeference of its own, so it is kept hidden: placing it on the map is not built yet.'}
          </p>
        )}
        {error && (
          <p className="notice danger small" role="alert">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        {draft && (
          <div className="b-heights-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || !project}
              onClick={() => void start()}
            >
              {busy ? 'Copying' : 'Import'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
