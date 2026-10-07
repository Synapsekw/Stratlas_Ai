import {
  DEFAULT_LOCAL_MODEL,
  defaultRoutes,
  formatMeter,
  PRICES_AS_OF,
  PROVIDER_LABELS,
  PROVIDERS,
  ROUTE_PROVIDERS,
  totalUsage,
  type ModelRoute,
} from '@aio/ai';
import { brand } from '@aio/brand';
import type { AiProvider, AiTask } from '@aio/schema';
import {
  Icon,
  SevChip,
  Switch,
  t,
  useT,
  type IconName,
  type MessageKey,
  shortcutHint,
} from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { setAuthorName, useAuthor } from '../author';
import { GPU_TIERS, TIER_ORDER, graphics, useGraphics, type GpuTier } from '../graphics';
import { cloudAiBlocked } from '../player';
import { bridge, shell, useCall, useShell } from '../shell';
import { HelpLink } from '../help/HelpPanel';
import { SETTINGS_HELP } from '../help/store';
import { About } from './settings/About';
import { DetectionModels } from './settings/DetectionModels';
import { Appearance } from './settings/Appearance';
import { Keyboard } from './settings/Keyboard';
import { LocalModel } from './settings/LocalModel';
import { MapPacks } from './settings/MapPacks';
import { ProviderConnection } from './settings/ProviderConnection';
import { ReportBranding } from './settings/ReportBranding';
import { TeamServer } from './settings/TeamServer';

type Page =
  | 'ai'
  | 'usage'
  | 'privacy'
  | 'data'
  | 'maps'
  | 'severity'
  | 'branding'
  | 'graphics'
  | 'appearance'
  | 'keyboard'
  | 'about';

const PAGES: { page: Page; label: MessageKey; icon: IconName; group: MessageKey }[] = [
  { page: 'ai', label: 'settings.page.ai', icon: 'agent', group: 'settings.group.intelligence' },
  {
    page: 'usage',
    label: 'settings.page.usage',
    icon: 'report',
    group: 'settings.group.intelligence',
  },
  {
    page: 'privacy',
    label: 'settings.page.privacy',
    icon: 'shield',
    group: 'settings.group.intelligence',
  },
  { page: 'data', label: 'settings.page.data', icon: 'layers', group: 'settings.group.data' },
  { page: 'maps', label: 'settings.page.maps', icon: 'map', group: 'settings.group.data' },
  {
    page: 'severity',
    label: 'settings.page.severity',
    icon: 'issues',
    group: 'settings.group.data',
  },
  {
    page: 'branding',
    label: 'settings.page.branding',
    icon: 'report',
    group: 'settings.group.data',
  },
  {
    page: 'graphics',
    label: 'settings.page.graphics',
    icon: 'scene',
    group: 'settings.group.app',
  },
  {
    page: 'appearance',
    label: 'settings.page.appearance',
    icon: 'sun',
    group: 'settings.group.app',
  },
  { page: 'keyboard', label: 'settings.page.keyboard', icon: 'key', group: 'settings.group.app' },
  { page: 'about', label: 'settings.page.about', icon: 'refresh', group: 'settings.group.app' },
];

const millions = (n: number) => `${String(n / 1e6)} M`;

function Graphics() {
  const g = graphics();
  const renderer = useGraphics((s) => s.renderer);
  const detected = useGraphics((s) => s.detected);
  const override = useGraphics((s) => s.override);
  const tier = useGraphics((s) => s.tier);
  const facts = useGraphics((s) => s.facts);
  const limits = useGraphics((s) => s.limits);
  const pressure = useGraphics((s) => s.pressure);
  const pointCap = useGraphics((s) => s.pointCap);
  const p = GPU_TIERS[tier];
  const memGb = facts.systemMemory ? String(Math.round(facts.systemMemory / 2 ** 30)) : null;
  const choices: { id: GpuTier | null; label: string; hint: string }[] = [
    {
      id: null,
      label: `Auto (${GPU_TIERS[detected].label})`,
      hint: 'Follow the detected graphics card',
    },
    ...TIER_ORDER.map((t) => ({ id: t, label: GPU_TIERS[t].label, hint: GPU_TIERS[t].hint })),
  ];
  return (
    <>
      <div className="sblock">
        <h2>
          Quality preset <span className="sub">{p.label} in use</span>
        </h2>
        <p className="help">
          Sets the point budget, eye-dome lighting, shadow detail and render resolution. The point
          budget and lighting can still be changed in the point cloud panel.
        </p>
        <div className="seg pop-seg" role="group" aria-label="Graphics quality preset">
          {choices.map((c) => (
            <button
              key={c.id ?? 'auto'}
              type="button"
              aria-pressed={override === c.id}
              title={c.hint}
              onClick={() => {
                g.getState().setOverride(c.id);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sblock" data-testid="graphics-preset">
        <h2>{p.label}</h2>
        <div className="opt">
          <b>Point budget</b>
          <span>Points drawn at once across every cloud</span>
          <span className="mono">{millions(p.pointBudget)}</span>
        </div>
        <div className="opt">
          <b>Eye-dome lighting</b>
          <span>Depth shading of point clouds</span>
          <span className="mono">{p.edl ? 'On' : 'Off'}</span>
        </div>
        <div className="opt">
          <b>Shadow map</b>
          <span>Sun shadow detail, texels</span>
          <span className="mono">{p.shadowMapSize}</span>
        </div>
        <div className="opt">
          <b>{t('settings.graphics.shadowSoftness')}</b>
          <span>{t('settings.graphics.shadowSoftnessHint')}</span>
          <span className="mono">{p.shadowSoftness}</span>
        </div>
        <div className="opt">
          <b>{t('settings.graphics.water')}</b>
          <span>{t('settings.graphics.waterHint')}</span>
          <span className="mono">
            {t(
              p.water === 'full' ? 'settings.graphics.waterFull' : 'settings.graphics.waterSimple',
            )}
          </span>
        </div>
        <div className="opt">
          <b>Pixel ratio</b>
          <span>Highest render resolution on high density screens</span>
          <span className="mono">{p.maxPixelRatio}x</span>
        </div>
        <div className="opt">
          <b>{t('settings.graphics.pointCap')}</b>
          <span>{t('settings.graphics.pointCapHint')}</span>
          <span className="mono">{millions(pointCap)}</span>
        </div>
        <div className="opt">
          <b>{t('settings.graphics.maxTexture')}</b>
          <span>{t('settings.graphics.maxTextureHint')}</span>
          <span className="mono">{p.maxTextureSize}</span>
        </div>
        <div className="opt">
          <b>{t('settings.graphics.memoryLimit')}</b>
          <span>{t('settings.graphics.memoryLimitHint')}</span>
          <span className="mono">{String(p.gpuBytes / 2 ** 30)} GB</span>
        </div>
        {pressure > 0 && (
          <p className="help" data-testid="graphics-pressure">
            {t('settings.graphics.pressure', { tier: p.label })}
          </p>
        )}
      </div>
      <div className="sblock">
        <h2>Graphics card</h2>
        <p className="help mono">{renderer ?? 'Not reported by the system'}</p>
        {memGb && <p className="help">{t('settings.graphics.memory', { size: memGb })}</p>}
        {limits.includes('memory') && memGb && (
          <p className="help">
            {t('settings.graphics.limitMemory', { tier: GPU_TIERS[detected].label, size: memGb })}
          </p>
        )}
        {limits.includes('texture') && (
          <p className="help">{t('settings.graphics.limitTexture')}</p>
        )}
        <p className="help">
          Press {shortcutHint('scene.perf')} in the 3D view for frame rate and memory.
        </p>
      </div>
    </>
  );
}

const PROVIDER_INFO: Record<
  AiProvider,
  { name: string; logo: string; placeholder: string; models: string[] }
> = {
  anthropic: {
    name: 'Anthropic',
    logo: 'A',
    placeholder: 'Paste an Anthropic API key',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  },
  openai: {
    name: 'OpenAI',
    logo: 'O',
    placeholder: 'Paste an OpenAI API key',
    models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
  },
  google: {
    name: 'Google Gemini',
    logo: 'G',
    placeholder: 'Paste a Gemini API key',
    models: ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  },
  local: {
    name: 'Local model',
    logo: 'L',
    placeholder: '',
    models: [DEFAULT_LOCAL_MODEL.model],
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
      <ProviderConnection provider={provider} keyPresent={present} />
    </div>
  );
}

function Routing() {
  const routes = useShell((s) => s.settings.routes);
  const localModel = useShell((s) => s.settings.localModel);
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
                        model:
                          provider === 'local'
                            ? (localModel?.model ?? DEFAULT_LOCAL_MODEL.model)
                            : (PROVIDER_INFO[provider].models[0] ?? r.model),
                      });
                    }}
                  >
                    {ROUTE_PROVIDERS.map((p) => (
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

const usd = (n: number, known: boolean) =>
  `${known ? '' : 'at least '}$${n < 0.01 && n > 0 ? '<0.01' : n.toFixed(2)}`;

/** AI-7: tokens and estimated cost per project and provider on this workstation. */
function Usage() {
  const data = useCall('ai:usage', {}, 0);
  if (data === null) return <div className="skel-line" />;
  if (!data.ok) {
    return (
      <p className="notice warn">
        <Icon name="warn" size={14} />
        {data.error}
      </p>
    );
  }
  const projects = data.value.projects;
  const all = totalUsage(projects.flatMap((p) => p.providers));
  return (
    <div className="sblock">
      <h2>
        By project{' '}
        <span className="sub">
          {formatMeter(all.inputTokens + all.outputTokens, all.costKnown ? all.costUsd : undefined)}
        </span>
      </h2>
      <p className="help">
        Estimates from list prices checked on {PRICES_AS_OF}; the provider&apos;s invoice is
        authoritative. A local model costs nothing per token.
      </p>
      {projects.length === 0 ? (
        <p className="help">No agent use yet.</p>
      ) : (
        <table className="tbl" aria-label="Agent usage by project and provider">
          <thead>
            <tr>
              <th>Project</th>
              <th>Provider</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
              <th>Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {projects.flatMap((p) =>
              p.providers.map((u, i) => (
                <tr key={`${p.key}:${u.provider}`}>
                  <td>{i === 0 ? <b className="hi">{p.name}</b> : null}</td>
                  <td>
                    {u.provider in PROVIDER_LABELS
                      ? PROVIDER_LABELS[u.provider as keyof typeof PROVIDER_LABELS]
                      : u.provider}
                  </td>
                  <td className="mono">{u.inputTokens.toLocaleString('en-US')}</td>
                  <td className="mono">{u.outputTokens.toLocaleString('en-US')}</td>
                  <td className="mono">{usd(u.costUsd, u.costKnown)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Privacy() {
  const cloudAi = useShell((s) => s.settings.cloudAi);
  const pkg = useShell((s) => s.pkg);
  return (
    <>
      {cloudAiBlocked(pkg) && (
        <p className="notice warn" role="status">
          <Icon name="lock" size={14} />
          The open package does not allow cloud AI. While it is open nothing is sent to any
          provider, whatever this switch says.
        </p>
      )}
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
      <OfflineOnly />
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

function OfflineOnly() {
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  return (
    <div className="sblock">
      <div className="master">
        <b>Offline-only workstation</b>
        <Switch
          checked={offlineOnly}
          label="Offline-only workstation"
          onChange={(v) => void shell.getState().updateSettings({ offlineOnly: v })}
        />
        <p>
          {offlineOnly
            ? 'On: map pack downloads and online update checks are disabled. Packs and updates come in as files.'
            : 'Off: you can start a map pack download or an update check yourself. Nothing goes online on its own.'}
        </p>
      </div>
    </div>
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
      <PipelinePack dataRoot={dataRoot} />
    </>
  );
}

function PipelinePack({ dataRoot }: { dataRoot: string }) {
  const list = useCall('jobs:list', {}, dataRoot);
  const runtime = list?.ok ? list.value.runtime : null;
  return (
    <div className="sblock">
      <h2>Pipeline pack</h2>
      <p className="help">
        Builder pipelines run in a separately installed Python pack, found in{' '}
        <span className="mono">runtime\pipeline-pack-&lt;version&gt;\</span> inside the data folder.
      </p>
      <div className="path-row" data-testid="pipeline-pack">
        <Icon name={runtime?.found ? 'check' : 'warn'} size={14} className="faint" />
        {list === null ? (
          <span className="faint">Looking</span>
        ) : !list.ok ? (
          <span>{list.error}</span>
        ) : runtime?.found ? (
          <span>
            Version <b className="mono">{runtime.version}</b>{' '}
            <span className="mono faint">{runtime.dir}</span>
          </span>
        ) : (
          <span>{runtime?.problem}</span>
        )}
      </div>
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

const HEAD: Record<Page, { title: MessageKey; text: MessageKey }> = {
  ai: { title: 'settings.page.ai', text: 'settings.ai.text' },
  usage: { title: 'settings.page.usage', text: 'settings.usage.text' },
  privacy: { title: 'settings.page.privacy', text: 'settings.privacy.text' },
  data: { title: 'settings.page.data', text: 'settings.data.text' },
  maps: { title: 'settings.page.maps', text: 'settings.maps.text' },
  severity: { title: 'settings.page.severity', text: 'settings.severity.text' },
  branding: { title: 'settings.page.branding', text: 'settings.branding.text' },
  graphics: { title: 'settings.page.graphics', text: 'settings.graphics.text' },
  appearance: { title: 'settings.page.appearance', text: 'settings.appearance.text' },
  keyboard: { title: 'settings.page.keyboard', text: 'settings.keyboard.text' },
  about: { title: 'settings.page.about', text: 'settings.about.text' },
};

export function SettingsScreen() {
  useT();
  const [page, setPage] = useState<Page>('ai');
  const error = useShell((s) => s.settingsError);
  return (
    <section className="screen settings" aria-label={t('settings.title')}>
      <nav className="set-nav" aria-label={t('settings.sections')}>
        <h2>{t('settings.title')}</h2>
        {PAGES.map((p, i) => {
          const head = i === 0 || PAGES[i - 1]?.group !== p.group ? p.group : null;
          return (
            <div key={p.page}>
              {head && <div className="grp caps">{t(head)}</div>}
              <button
                type="button"
                aria-current={page === p.page}
                onClick={() => {
                  setPage(p.page);
                }}
              >
                <Icon name={p.icon} />
                {t(p.label)}
              </button>
            </div>
          );
        })}
      </nav>
      <div className="set-body">
        <div className="set-page">
          <header>
            <div>
              <h1>{t(HEAD[page].title)}</h1>
              <p>{t(HEAD[page].text, { product: brand.productName })}</p>
            </div>
            {SETTINGS_HELP[page] && <HelpLink topic={SETTINGS_HELP[page]} />}
          </header>
          {error && (
            <p className="notice warn" role="status">
              <Icon name="warn" size={14} />
              {t('settings.notSaved', { error })}
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
              <LocalModel />
              <Routing />
            </>
          )}
          {page === 'ai' && <DetectionModels />}
          {page === 'usage' && <Usage />}
          {page === 'privacy' && <Privacy />}
          {page === 'data' && <DataFolder />}
          {page === 'data' && <TeamServer />}
          {page === 'maps' && <MapPacks />}
          {page === 'severity' && <Severity />}
          {page === 'branding' && <ReportBranding />}
          {page === 'graphics' && <Graphics />}
          {page === 'appearance' && <Appearance />}
          {page === 'keyboard' && <Keyboard />}
          {page === 'about' && <About />}
        </div>
      </div>
    </section>
  );
}
