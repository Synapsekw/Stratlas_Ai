import type { LibraryEntry } from '@aio/schema';
import { formatBytes, formatCompact, formatDate, Icon, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { shell, useCall, useShell } from '../shell';

const LAYER_CHIPS: { key: string; icon: IconName; label: string }[] = [
  { key: 'mesh', icon: 'scene', label: 'Models' },
  { key: 'pointcloud', icon: 'cloud', label: 'Point clouds' },
  { key: 'raster', icon: 'raster', label: 'Rasters' },
  { key: 'video', icon: 'video', label: 'Video clips' },
  { key: 'photos', icon: 'photo', label: 'Photos' },
  { key: 'panoramas', icon: 'pano', label: 'Panoramas' },
  { key: 'issues', icon: 'issues', label: 'Issues' },
];

const KIND_LABEL: Record<LibraryEntry['kind'], string> = {
  native: 'Native project',
  aik: 'Inspection kit',
  volumetric: 'Volumetric survey',
  road: 'Road survey',
  twin: 'Digital twin',
};

type Sort = 'recent' | 'name';

function sortEntries(list: readonly LibraryEntry[], sort: Sort): LibraryEntry[] {
  const copy = [...list];
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  const key = (e: LibraryEntry) => e.lastOpened ?? e.captureDate ?? '';
  return copy.sort((a, b) => key(b).localeCompare(key(a)) || a.name.localeCompare(b.name));
}

function Thumb({ entry }: { entry: LibraryEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.thumbnail && !failed) {
    return (
      <img
        className="pc-img"
        src={entry.thumbnail}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  return (
    <div className="pc-ph" aria-hidden="true">
      <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <path
            key={i}
            d={`M-10 ${String(70 - i * 9)} C 30 ${String(52 - i * 9)}, 60 ${String(80 - i * 10)}, 100 ${String(58 - i * 8)} S 150 ${String(44 - i * 7)}, 175 ${String(54 - i * 8)}`}
          />
        ))}
      </svg>
      <Icon name="layers" size={20} />
    </div>
  );
}

function ProjectCard({
  entry,
  opening,
  current,
}: {
  entry: LibraryEntry;
  opening: boolean;
  current: boolean;
}) {
  const counts = entry.layerCounts ?? {};
  const chips = LAYER_CHIPS.filter((c) => (counts[c.key] ?? 0) > 0);
  const where = [entry.customer, entry.site].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`pcard${opening ? ' opening' : ''}${current ? ' current' : ''}`}
      onClick={() => {
        if (!opening) void shell.getState().openProject(entry.path);
      }}
      aria-busy={opening}
      title={entry.path}
      data-testid="project-card"
    >
      <div className="pc-media">
        <Thumb entry={entry} />
        <span className="pc-kind">{KIND_LABEL[entry.kind]}</span>
        {current && <span className="pc-open">Open</span>}
        {opening && (
          <span className="pc-busy">
            <span className="spin" />
            Opening
          </span>
        )}
      </div>
      <div className="pc-body">
        <div className="pc-row">
          <b className="pc-name">{entry.name}</b>
          {entry.captureDate && <span className="pc-date">{formatDate(entry.captureDate)}</span>}
        </div>
        <div className="pc-row">
          <span className="pc-where">{where || entry.path}</span>
          {entry.sizeBytes !== undefined && (
            <span className="pc-size mono">{formatBytes(entry.sizeBytes)}</span>
          )}
        </div>
        {chips.length > 0 && (
          <div className="pc-chips">
            {chips.map((c) => (
              <span key={c.key} className="lchip" title={c.label}>
                <Icon name={c.icon} size={12} />
                {formatCompact(counts[c.key] ?? 0)}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function PackageDiagram() {
  const rows: [string, string][] = [
    ['projects\\', ''],
    ['  <project>\\', ''],
    ['    manifest.json', 'layers, CRS, severity models'],
    ['    issues.json', 'issue register'],
    ['    thumbnail.jpg', 'library poster'],
    ['    models\\  video\\  clouds\\', ''],
    ['    rasters\\  photos\\  panoramas\\', ''],
    ['packs\\', 'offline map packs'],
  ];
  return (
    <pre className="pkg-tree" aria-label="Project folder layout">
      {rows.map(([a, b]) => (
        <span key={a}>
          {a}
          {b && <i>{b}</i>}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function EmptyLibrary({ dataRoot, error }: { dataRoot: string; error: string | null }) {
  return (
    <div className="lib-empty">
      <div className="le-text">
        <span className="le-ic">
          <Icon name="projects" size={20} />
        </span>
        <h2>No projects in the library yet</h2>
        <p>
          Projects live as folders inside your data folder. Each one holds a{' '}
          <code>manifest.json</code> with its models, clips, maps and issues. Imported projects
          appear here as soon as their folder is in place.
        </p>
        <dl className="kv le-kv">
          <dt>Data folder</dt>
          <dd className="mono">{dataRoot || 'Not set yet'}</dd>
          <dt>Projects in</dt>
          <dd className="mono">{dataRoot ? `${dataRoot}\\projects` : 'Set a data folder first'}</dd>
        </dl>
        <div className="le-acts">
          <button
            type="button"
            className="btn primary"
            onClick={() => void shell.getState().addProjectFolder()}
          >
            <Icon name="plus" size={14} />
            Add project folder
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => void shell.getState().chooseDataRoot()}
          >
            <Icon name="import" size={14} />
            Change data folder
          </button>
        </div>
        {error && (
          <p className="notice warn" role="status">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
      </div>
      <PackageDiagram />
    </div>
  );
}

function Workstation() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const packs = useCall('packs:list', {}, dataRoot);
  return (
    <aside className="home-side" aria-label="Workstation">
      <section className="hs-sec">
        <h3 className="caps">Data folder</h3>
        <div className="hs-path mono">{dataRoot || 'Not set'}</div>
        <button
          type="button"
          className="btn sm"
          onClick={() => void shell.getState().chooseDataRoot()}
        >
          Change
        </button>
      </section>
      <section className="hs-sec">
        <h3 className="caps">
          Offline map packs
          <button
            type="button"
            className="link"
            onClick={() => {
              shell.getState().go('settings');
            }}
          >
            Manage
          </button>
        </h3>
        {packs === null && <div className="skel-line" />}
        {packs && !packs.ok && <p className="faint small">{packs.error}</p>}
        {packs?.ok && packs.value.length === 0 && (
          <p className="faint small">No packs installed. Maps show project rasters only.</p>
        )}
        {packs?.ok &&
          packs.value.map((p) => (
            <div key={p.id} className="pack">
              <span className="hi">{p.label}</span>
              <span className="mono">{formatBytes(p.sizeBytes)}</span>
              <span className="state ok">
                <i />z{p.maxZoom}
              </span>
            </div>
          ))}
      </section>
      <section className="hs-sec">
        <h3 className="caps">Keyboard</h3>
        <div className="keys">
          <span>Search everything</span>
          <span className="kbd">Ctrl K</span>
          <span>Collapse sidebar</span>
          <span className="kbd">Ctrl B</span>
          <span>Play or pause</span>
          <span className="kbd">Space</span>
        </div>
      </section>
    </aside>
  );
}

export function ProjectsScreen() {
  const library = useShell((s) => s.library);
  const libraryError = useShell((s) => s.libraryError);
  const opening = useShell((s) => s.opening);
  const openError = useShell((s) => s.openError);
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const currentRoot = useWorkspace((s) => s.project?.root);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (library ?? []).filter(
      (e) => !q || [e.name, e.customer, e.site].some((v) => v?.toLowerCase().includes(q)),
    );
    return sortEntries(list, sort);
  }, [library, query, sort]);

  const total = (library ?? []).reduce((n, e) => n + (e.sizeBytes ?? 0), 0);
  const empty = library !== null && library.length === 0;

  return (
    <section className="screen home" aria-label="Projects">
      <div className="home-main">
        <header className="home-h">
          <div>
            <h1>Project library</h1>
            <p className="muted">
              {library === null
                ? 'Reading the library'
                : `${String(library.length)} ${library.length === 1 ? 'project' : 'projects'}${total ? ` · ${formatBytes(total)} on this workstation` : ''}`}
            </p>
          </div>
          <div className="home-acts">
            {!empty && (
              <>
                <input
                  className="input lib-filter"
                  type="search"
                  placeholder="Filter by name, client or site"
                  aria-label="Filter projects"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                />
                <div className="seg" role="group" aria-label="Sort">
                  <button
                    type="button"
                    aria-pressed={sort === 'recent'}
                    onClick={() => {
                      setSort('recent');
                    }}
                  >
                    Recent
                  </button>
                  <button
                    type="button"
                    aria-pressed={sort === 'name'}
                    onClick={() => {
                      setSort('name');
                    }}
                  >
                    Name
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              className="btn primary"
              onClick={() => void shell.getState().addProjectFolder()}
            >
              <Icon name="plus" size={14} />
              Add project folder
            </button>
          </div>
        </header>
        {openError && (
          <div className="notice danger" role="alert">
            <Icon name="warn" size={14} />
            <span>
              <b>The project did not open.</b> {openError}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={shell.getState().dismissOpenError}
            >
              Dismiss
            </button>
          </div>
        )}
        {library === null && (
          <div className="pgrid" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pcard skel" />
            ))}
          </div>
        )}
        {empty && <EmptyLibrary dataRoot={dataRoot} error={libraryError} />}
        {library !== null && !empty && (
          <>
            {libraryError && (
              <p className="notice warn" role="status">
                <Icon name="warn" size={14} />
                {libraryError}
              </p>
            )}
            {shown.length === 0 ? (
              <p className="faint no-match">No project matches “{query}”.</p>
            ) : (
              <div className="pgrid">
                {shown.map((e) => (
                  <ProjectCard
                    key={e.id}
                    entry={e}
                    opening={opening === e.path}
                    current={currentRoot === e.path}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <Workstation />
    </section>
  );
}
