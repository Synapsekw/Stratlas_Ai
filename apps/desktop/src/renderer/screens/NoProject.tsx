import { Icon } from '@aio/ui';
import { shell, useShell } from '../shell';

/** Shown by project views while no project is open. */
export function NoProject({ view }: { view: string }) {
  const library = useShell((s) => s.library);
  const recent = (library ?? []).slice(0, 4);
  return (
    <section className="screen no-project" aria-label={view}>
      <div className="np">
        <span className="le-ic">
          <Icon name="layers" size={20} />
        </span>
        <h1>Open a project to see its {view.toLowerCase()}</h1>
        <p className="muted">
          {view} works on one project at a time. Pick one from the library, or press{' '}
          <span className="kbd">Ctrl K</span> and type its name.
        </p>
        {recent.length > 0 && (
          <div className="np-list">
            {recent.map((e) => (
              <button
                key={e.id}
                type="button"
                className="np-item"
                onClick={() => void shell.getState().openProject(e.path)}
              >
                <Icon name="layers" size={14} />
                <span>{e.name}</span>
                {e.customer && <span className="mono faint">{e.customer}</span>}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => {
            shell.getState().go('projects');
          }}
        >
          <Icon name="projects" size={14} />
          Go to the library
        </button>
      </div>
    </section>
  );
}
