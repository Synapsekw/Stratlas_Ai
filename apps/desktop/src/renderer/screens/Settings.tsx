import { defaultRoutes, PROVIDERS, type ModelRoute } from '@aio/ai';
import type { AiProvider, AiTask } from '@aio/schema';
import { formatBytes, Icon, SevChip, Switch, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { setAuthorName, useAuthor } from '../author';
import { bridge, shell, useCall, useShell } from '../shell';

type Page = 'ai' | 'privacy' | 'data' | 'maps' | 'severity';

const PAGES: { page: Page; label: string; icon: IconName; group: string }[] = [
  { page: 'ai', label: 'AI providers', icon: 'agent', group: 'Intelligence' },
  { page: 'privacy', label: 'Privacy and cloud', icon: 'shield', group: 'Intelligence' },
  { page: 'data', label: 'Data folder', icon: 'layers', group: 'Data' },
  { page: 'maps', label: 'Offline maps', icon: 'map', group: 'Data' },
  { page: 'severity', label: 'Severity models', icon: 'issues', group: 'Data' },
];

const PROVIDER_INFO: Record<
  AiProvider,
  { name: string; logo: string; placeholder: string; models: string[] }
> = {
  anthropic: {
    name: 'Anthropic',
    logo: 'A',
    placeholder: 'Paste an Anthropic API key',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    name: 'OpenAI',
    logo: 'O',
    placeholder: 'Paste an OpenAI API key',
    models: ['gpt-5', 'gpt-5-mini'],
  },
  google: {
    name: 'Google Gemini',
    logo: 'G',
    placeholder: 'Paste a Gemini API key',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
};

const TASKS: { task: AiTask; label: string; icon: IconName; sends: string }[] = [
  { task: 'chat', label: 'Agent chat', icon: 'agent', sends: 'Text, view context' },
  { task: 'vision', label: 'Photo and frame vision', icon: 'photo', sends: 'Frames, crops' },
  { task: 'report', label: 'Report writing', icon: 'report', sends: 'Issue text' },
  { task: 'extract', label: 'Structured extraction', icon: 'raster', sends: 'Text, tables' },
  { task: 'build', label: 'Build from drawings', icon: 'scene', sends: 'Drawings, clouds' },
];

function ProviderRow({ provider }: { provider: AiProvider }) {
  const info = PROVIDER_INFO[provider];
  const [rev, setRev] = useState(0);
  const status = useCall('ai:hasKey', { provider }, rev);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const present = status?.ok === true && status.value.present;
  const showInput = !present || editing;

  const save = async () => {
    const k = key.trim();
    if (k.length < 8) {
      setError('That key is too short. Paste the whole key.');
      return;
    }
    setSaving(true);
    const r = await bridge.call('ai:setKey', { provider, key: k });
    setSaving(false);
    if (!r.ok || !r.value.ok) {
      setError(r.ok ? 'The system vault did not accept the key.' : r.error);
      return;
    }
    setKey('');
    setError(null);
    setEditing(false);
    setRev((n) => n + 1);
  };

  return (
    <div className="prov">
      <div className="plogo">{info.logo}</div>
      <div>
        <div className="pn">
          {info.name}
          {status === null ? (
            <span className="state no">
              <i />
              Checking
            </span>
          ) : present ? (
            <span className="state ok">
              <i />
              Key stored
            </span>
          ) : (
            <span className="state no">
              <i />
              {status.ok ? 'Not set up' : 'Vault unavailable'}
            </span>
          )}
        </div>
        <div className="pk">{info.models.join(' · ')}</div>
      </div>
      <div className="prov-acts">
        {present && !editing && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            Replace key
          </button>
        )}
      </div>
      {showInput ? (
        <form
          className="key"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Icon name="key" size={14} className="faint" />
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={info.placeholder}
            aria-label={`${info.name} API key`}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError(null);
            }}
          />
          {editing && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setEditing(false);
                setKey('');
                setError(null);
              }}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="btn sm primary"
            disabled={saving || key.trim().length === 0}
          >
            {saving ? 'Saving' : 'Save to vault'}
          </button>
        </form>
      ) : (
        <div className="key stored">
          <Icon name="lock" size={14} className="faint" />
          <span className="faint">
            Stored in the system credential vault. It is never shown again.
          </span>
        </div>
      )}
      {error && (
        <p className="prov-err" role="alert">
          {error}
        </p>
      )}
      {status && !status.ok && <p className="prov-err">{status.error}</p>}
    </div>
  );
}

function Routing() {
  const routes = useShell((s) => s.settings.routes);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = (next: ModelRoute[]) => void shell.getState().updateSettings({ routes: next });
  const routeFor = (task: AiTask): ModelRoute =>
    routes.find((r) => r.task === task) ??
    defaultRoutes().find((r) => r.task === task) ?? {
      task,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    };
  const replace = (task: AiTask, patch: Partial<ModelRoute>) => {
    const next = TASKS.map(({ task: t }) =>
      t === task ? { ...routeFor(t), ...patch } : routeFor(t),
    );
    save(next);
  };

  return (
    <div className="sblock">
      <h2>
        Model routing <span className="sub">per task</span>
        <span className="acts">
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setDraft({});
              save(defaultRoutes());
            }}
          >
            Reset to defaults
          </button>
        </span>
      </h2>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '32%' }}>Task</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Sends</th>
          </tr>
        </thead>
        <tbody>
          {TASKS.map(({ task, label, icon, sends }) => {
            const r = routeFor(task);
            const listId = `models-${task}`;
            return (
              <tr key={task}>
                <td>
                  <div className="cell-h">
                    <Icon name={icon} size={14} className="faint" />
                    {label}
                  </div>
                </td>
                <td>
                  <select
                    className="input"
                    aria-label={`Provider for ${label}`}
                    value={r.provider}
                    onChange={(e) => {
                      const provider = e.target.value as AiProvider;
                      replace(task, {
                        provider,
                        model: PROVIDER_INFO[provider].models[0] ?? r.model,
                      });
                    }}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_INFO[p].name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="input mono"
                    aria-label={`Model for ${label}`}
                    list={listId}
                    value={draft[task] ?? r.model}
                    onChange={(e) => {
                      setDraft({ ...draft, [task]: e.target.value });
                    }}
                    onBlur={() => {
                      const v = draft[task]?.trim();
                      if (v && v !== r.model) replace(task, { model: v });
                      setDraft(
                        Object.fromEntries(Object.entries(draft).filter(([k]) => k !== task)),
                      );
                    }}
                  />
                  <datalist id={listId}>
                    {PROVIDER_INFO[r.provider].models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </td>
                <td className="faint nowrap">{sends}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Privacy() {
  const cloudAi = useShell((s) => s.settings.cloudAi);
  return (
    <>
      <div className="sblock">
        <div className="master">
          <b>Cloud AI</b>
          <Switch
            checked={cloudAi}
            label="Allow cloud AI"
            onChange={(v) => void shell.getState().updateSettings({ cloudAi: v })}
          />
          <p>
            {cloudAi
              ? 'On: the agent may send text and frames to the providers you set up. Every data-sending step still asks first.'
              : 'Off: nothing leaves this workstation. The agent panel stays available for local tools only.'}
          </p>
        </div>
      </div>
      <div className="sblock">
        <h2>Always on</h2>
        <div className="opt">
          <b>
            Ask before data-sending actions <Icon name="lock" size={12} className="faint" />
          </b>
          <span>Frames, photos and clips</span>
          <Switch
            checked
            label="Ask before data-sending actions"
            disabled
            onChange={() => undefined}
          />
        </div>
        <div className="opt">
          <b>
            Ask before changing project data <Icon name="lock" size={12} className="faint" />
          </b>
          <span>Writes, merges and deletes</span>
          <Switch
            checked
            label="Ask before changing project data"
            disabled
            onChange={() => undefined}
          />
        </div>
      </div>
    </>
  );
}

function AuthorName() {
  const { override, osUser } = useAuthor();
  const [value, setValue] = useState(override);
  return (
    <div className="sblock">
      <h2>Your name on issues</h2>
      <p className="help">
        New issues and their audit trail carry this name.
        {osUser ? ` Leave it empty to use your account name, ${osUser}.` : ''}
      </p>
      <input
        className="input"
        aria-label="Your name on issues"
        style={{ width: '100%', maxWidth: 320 }}
        value={value}
        placeholder={osUser || 'Your name'}
        maxLength={80}
        onChange={(e) => {
          setValue(e.target.value);
          setAuthorName(e.target.value);
        }}
      />
    </div>
  );
}

function DataFolder() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  return (
    <>
      <AuthorName />
      <div className="sblock">
        <h2>Data folder</h2>
        <p className="help">
          Projects live in <span className="mono">projects\</span> and map packs in{' '}
          <span className="mono">packs\</span> inside this folder. Changing it reloads the library.
        </p>
        <div className="path-row">
          <Icon name="layers" size={14} className="faint" />
          <span className="mono">{dataRoot || 'Not set'}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void shell.getState().chooseDataRoot()}
          >
            Change folder
          </button>
        </div>
      </div>
    </>
  );
}

function Maps() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const packs = useCall('packs:list', {}, dataRoot);
  return (
    <div className="sblock">
      <h2>
        Installed packs{' '}
        <span className="sub">
          {packs?.ok
            ? `${String(packs.value.length)} · ${formatBytes(packs.value.reduce((n, p) => n + p.sizeBytes, 0))}`
            : ''}
        </span>
      </h2>
      {packs === null && <div className="skel-line" />}
      {packs && !packs.ok && (
        <p className="notice warn">
          <Icon name="warn" size={14} />
          {packs.error}
        </p>
      )}
      {packs?.ok && packs.value.length === 0 && (
        <p className="help">
          No map packs in{' '}
          <span className="mono">{dataRoot ? `${dataRoot}\\packs` : 'the data folder'}</span>. Maps
          show project rasters only until a pack is added.
        </p>
      )}
      {packs?.ok && packs.value.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Region</th>
              <th>Size</th>
              <th>Max zoom</th>
              <th>Bounds</th>
            </tr>
          </thead>
          <tbody>
            {packs.value.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="cell-h">
                    <Icon name="globe" size={14} className="faint" />
                    <b className="hi">{p.label}</b>
                    <span className="mono faint">{p.id}</span>
                  </div>
                </td>
                <td className="mono">{formatBytes(p.sizeBytes)}</td>
                <td className="mono">z{p.maxZoom}</td>
                <td className="mono faint">{p.bbox.map((v) => v.toFixed(1)).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Severity() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const models = project?.manifest.severityModels ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = models.find((m) => m.id === picked) ?? models[0];
  if (!project) {
    return <p className="help">Open a project to see the severity models it grades issues with.</p>;
  }
  if (!current) return <p className="help">{project.manifest.name} has no severity model.</p>;
  return (
    <div className="sev-ed">
      <div className="models-list">
        <div className="caps faint ml-h">{project.manifest.name}</div>
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-current={m.id === current.id}
            onClick={() => {
              setPicked(m.id);
            }}
          >
            <b>{m.name}</b>
            <span>{m.levels.length} levels</span>
            <span className="sevbar">
              {[...m.levels].reverse().map((l) => (
                <i key={l.value} style={{ flex: 1, background: l.color }} />
              ))}
            </span>
          </button>
        ))}
      </div>
      <div>
        <div className="sev-title">
          <b>{current.name}</b>
          <span className="faint">
            {issues.filter((i) => i.severityModelId === current.id).length} issues graded · read
            only in this build
          </span>
        </div>
        <div className="levels">
          <div className="levels-h">
            <span>Level</span>
            <span>Name</span>
            <span>Criteria</span>
            <span>Recommended action</span>
          </div>
          {[...current.levels].reverse().map((l) => (
            <div key={l.value} className="lvl">
              <span className="sw" style={{ background: l.color }}>
                {l.value}
              </span>
              <div className="ln">
                <b>{l.label}</b>
              </div>
              <div className="lc">{l.criteria}</div>
              <div className="la">{l.action ?? 'None given'}</div>
            </div>
          ))}
          {current.uncertain && (
            <div className="lvl uncertain">
              <span className="sw">?</span>
              <div className="ln">
                <b>{current.uncertain.label}</b>
              </div>
              <div className="lc">Not gradable from the imagery available.</div>
              <div className="la">Re-capture or inspect manually.</div>
            </div>
          )}
        </div>
        <div className="preview-strip">
          <span className="caps faint">Preview</span>
          {[...current.levels].reverse().map((l) => (
            <SevChip key={l.value} color={l.color}>
              {l.value} {l.label}
            </SevChip>
          ))}
        </div>
      </div>
    </div>
  );
}

const HEAD: Record<Page, { title: string; text: string }> = {
  ai: {
    title: 'AI providers',
    text: 'Keys go to the system credential vault. They never enter project files or logs, and the app never shows a stored key.',
  },
  privacy: {
    title: 'Privacy and cloud',
    text: 'Stratlas works fully offline. Cloud AI is opt-in, and every action that sends data or changes the project asks you first.',
  },
  data: {
    title: 'Data folder',
    text: 'Where projects and offline map packs live on this workstation.',
  },
  maps: {
    title: 'Offline maps',
    text: 'Vector map packs render with no network. They are shared by every project on this workstation.',
  },
  severity: {
    title: 'Severity models',
    text: 'Each project grades issues with its own model. Levels carry a colour, criteria and a recommended action.',
  },
};

export function SettingsScreen() {
  const [page, setPage] = useState<Page>('ai');
  const error = useShell((s) => s.settingsError);
  return (
    <section className="screen settings" aria-label="Settings">
      <nav className="set-nav" aria-label="Settings sections">
        <h2>Settings</h2>
        {PAGES.map((p, i) => {
          const head = i === 0 || PAGES[i - 1]?.group !== p.group ? p.group : null;
          return (
            <div key={p.page}>
              {head && <div className="grp caps">{head}</div>}
              <button
                type="button"
                aria-current={page === p.page}
                onClick={() => {
                  setPage(p.page);
                }}
              >
                <Icon name={p.icon} />
                {p.label}
              </button>
            </div>
          );
        })}
      </nav>
      <div className="set-body">
        <div className="set-page">
          <header>
            <div>
              <h1>{HEAD[page].title}</h1>
              <p>{HEAD[page].text}</p>
            </div>
          </header>
          {error && (
            <p className="notice warn" role="status">
              <Icon name="warn" size={14} />
              Settings are not being saved: {error}
            </p>
          )}
          {page === 'ai' && (
            <>
              <div className="sblock">
                <h2>
                  Providers <span className="sub">{PROVIDERS.length} supported</span>
                </h2>
                {PROVIDERS.map((p) => (
                  <ProviderRow key={p} provider={p} />
                ))}
              </div>
              <Routing />
            </>
          )}
          {page === 'privacy' && <Privacy />}
          {page === 'data' && <DataFolder />}
          {page === 'maps' && <Maps />}
          {page === 'severity' && <Severity />}
        </div>
      </div>
    </section>
  );
}
