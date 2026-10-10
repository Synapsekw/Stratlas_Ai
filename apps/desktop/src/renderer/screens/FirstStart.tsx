import { brand } from '@aio/brand';
import type { LibraryEntry, SetupStatus } from '@aio/schema';
import { Icon, type IconName } from '@aio/ui';
import { useEffect, useState } from 'react';
import { shell, useCall, useShell } from '../shell';

type State = 'ok' | 'no' | 'warn';

interface Row {
  id: string;
  icon: IconName;
  title: string;
  state: State;
  status: string;
  explain: string;
  action?: { label: string; run: () => void };
}

/** One line per piece a first start may lack, with what it means and what to do. */
export function setupRows(s: SetupStatus, online: boolean): Row[] {
  return [
    {
      id: 'data',
      icon: 'projects',
      title: 'Data folder',
      state: s.dataRootExists ? 'ok' : 'warn',
      status: s.dataRootExists ? 'Ready' : 'Not created yet',
      explain: s.dataRootExists
        ? `Your projects and offline map packs live in ${s.dataRoot}.`
        : `Your own projects and map packs will live in ${s.dataRoot}. It is created with your first project; pick another folder any time. The demo does not need it.`,
      action: {
        label: s.dataRootExists ? 'Change' : 'Choose folder',
        run: () => void shell.getState().chooseDataRoot(),
      },
    },
    {
      id: 'maps',
      icon: 'map',
      title: 'Offline maps',
      state: s.mapPacks > 0 ? 'ok' : 'warn',
      status:
        s.mapPacks > 0
          ? `${String(s.mapPacks)} map ${s.mapPacks === 1 ? 'pack' : 'packs'}`
          : 'No map pack installed',
      explain:
        s.mapPacks > 0
          ? 'Maps show the installed packs under each project.'
          : "Maps show each project's own orthomosaics and plans. For a basemap, import a pack file or download a region in Settings, Offline maps.",
      action: {
        label: 'Offline maps',
        run: () => {
          shell.getState().go('settings');
        },
      },
    },
    {
      id: 'pipeline',
      icon: 'refresh',
      title: 'Pipeline pack',
      state: s.pipeline.found ? 'ok' : 'warn',
      status: s.pipeline.found
        ? `Installed${s.pipeline.version ? ` (${s.pipeline.version})` : ''}`
        : 'Not installed',
      explain: s.pipeline.found
        ? 'Builds projects from raw photos, surveys and road data in Jobs.'
        : 'Needed to build projects from raw data, for survey jobs and for Suggest boundaries (Jobs). Viewing, annotating, measuring, volumes, maps and reports work without it. It installs from its file in Settings, Processing tools.',
      action: {
        label: 'Processing tools',
        run: () => {
          shell.getState().openSettingsPage('tools');
        },
      },
    },
    {
      id: 'network',
      icon: online ? 'globe' : 'offline',
      title: 'Network',
      state: 'ok',
      status: online ? 'Online' : 'Offline',
      explain: `Not needed. ${brand.productName} never goes online by itself: map downloads, update checks and cloud AI run only when you start them.`,
    },
  ];
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => {
      setOnline(true);
    };
    const down = () => {
      setOnline(false);
    };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** What this workstation has and lacks: data folder, map packs, pipeline pack, network. */
export function SetupChecklist() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const status = useCall('app:setupStatus', {}, dataRoot);
  const online = useOnline();
  if (status === null) return <div className="skel-line" />;
  if (!status.ok) return <p className="faint small">{status.error}</p>;
  return (
    <ul className="setup-list" aria-label="This workstation" data-testid="setup-checklist">
      {setupRows(status.value, online).map((r) => (
        <li key={r.id} className="setup-row" data-testid={`setup-${r.id}`} data-state={r.state}>
          <span className="setup-ic" aria-hidden="true">
            <Icon name={r.icon} size={16} />
          </span>
          <div className="setup-txt">
            <div className="setup-h">
              <b>{r.title}</b>
              <span className={`state ${r.state}`}>
                <i />
                {r.status}
              </span>
            </div>
            <p>{r.explain}</p>
          </div>
          {r.action && (
            <button type="button" className="btn sm ghost" onClick={r.action.run}>
              {r.action.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The first-start welcome, while the library holds only the bundled demo projects: open the demo,
 * and what each missing piece means for this workstation.
 */
export function FirstStart({ demos }: { demos: LibraryEntry[] }) {
  const primary = demos.find((d) => d.demo?.primary) ?? demos[0];
  const others = demos.filter((d) => d !== primary);
  const opening = useShell((s) => s.opening);
  if (!primary) return null;
  const busy = opening === primary.path;
  return (
    <section className="first-start" aria-label="Welcome" data-testid="first-start">
      <div className="fs-intro">
        <span className="le-ic">
          <Icon name="drone" size={20} />
        </span>
        <h2>Welcome to {brand.productName}</h2>
        <p>
          Start with the demo project: a fictional tank farm with a 3D model, a drone video on the
          model, a map, a point cloud, issues with photos and two stockpiles surveyed twice. It is
          synthetic data made for trying things out, and your changes stay on this computer.
        </p>
        <div className="le-acts">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void shell.getState().openProject(primary.path)}
            data-testid="open-demo"
          >
            <Icon name="play" size={14} />
            {busy ? 'Opening the demo project' : 'Open the demo project'}
          </button>
          {others.map((o) => (
            <button
              key={o.id}
              type="button"
              className="btn"
              onClick={() => void shell.getState().openProject(o.path)}
            >
              <Icon name={o.kind === 'road' ? 'road' : 'projects'} size={14} />
              {o.name}
            </button>
          ))}
        </div>
      </div>
      <div className="fs-setup">
        <h3 className="caps">This workstation</h3>
        <SetupChecklist />
      </div>
    </section>
  );
}
