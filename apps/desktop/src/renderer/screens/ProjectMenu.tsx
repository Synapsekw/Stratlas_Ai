import type { LibraryEntry } from '@aio/schema';
import {
  Dialog,
  Icon,
  Menu,
  MenuAt as MenuAtPoint,
  useT,
  type IconName,
  type MenuItem,
  type MessageKey,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useId, useRef, useState, type SyntheticEvent } from 'react';
import { isActive } from '../jobs';
import { shell, useJobs, useShell } from '../shell';
import { removal } from '../shell/removal';
import { EmptyTrashDialog } from '../shell/RemoveHost';
import { CoverDialog } from './CoverDialog';
import { DeleteDialog } from './DeleteDialog';
import { MoveToFolderDialog } from './MoveToFolderDialog';
import {
  projectActions,
  samePathText,
  type ProjectActionId,
  type WhyNot,
} from './projectMenuModel';

export interface MenuAt {
  x: number;
  y: number;
}

const ICON: Record<ProjectActionId, IconName> = {
  open: 'chev-r',
  rename: 'anno',
  reveal: 'folder',
  thumbnail: 'photo',
  move: 'folder',
  emptyTrash: 'trash',
  export: 'download',
  close: 'x',
  remove: 'x',
  delete: 'trash',
};

const LABEL: Record<ProjectActionId, MessageKey> = {
  open: 'library.menu.open',
  rename: 'library.menu.rename',
  reveal: 'library.menu.reveal',
  thumbnail: 'library.menu.thumbnail',
  move: 'library.menu.move',
  emptyTrash: 'library.menu.emptyTrash',
  export: 'library.menu.export',
  close: 'library.menu.close',
  remove: 'library.menu.remove',
  delete: 'library.menu.delete',
};

const WHY: Record<WhyNot, MessageKey> = {
  package: 'library.menu.why.package',
  demo: 'library.menu.why.demo',
  kit: 'library.menu.why.kit',
  outside: 'library.menu.why.outside',
  open: 'library.menu.why.open',
  job: 'library.menu.why.job',
};

/** The last part of a path, whichever slash it uses. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function RenameDialog({
  entry,
  onClose,
  returnTo,
}: {
  entry: LibraryEntry;
  onClose: () => void;
  returnTo: () => HTMLElement | null;
}) {
  const t = useT();
  const form = useId();
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  const next = name.trim();

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!next || busy) return;
    if (next === entry.name) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    void shell
      .getState()
      .renameProject(entry, next)
      .then((failed) => {
        if (failed === null) onClose();
        else {
          setBusy(false);
          setError(failed);
        }
      });
  };

  return (
    <Dialog
      open
      title={t('library.rename.title')}
      testId="project-rename"
      hideClose
      returnFocus={returnTo}
      onClose={cancel}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
            {t('library.cancel')}
          </button>
          <button
            type="submit"
            form={form}
            className="btn primary"
            disabled={!next || busy}
            data-testid="project-rename-confirm"
          >
            {busy ? t('library.rename.busy') : t('library.rename.confirm')}
          </button>
        </>
      }
    >
      {/* Enter in the field renames; the form adds no box of its own (display: contents) */}
      <form id={form} style={{ display: 'contents' }} onSubmit={submit}>
        <input
          className="input"
          type="text"
          maxLength={120}
          aria-label={t('library.rename.field')}
          data-testid="project-rename-name"
          value={name}
          onFocus={(e) => {
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <p className="help" style={{ margin: 0 }}>
          {t('library.rename.help', { folder: folderName(entry.path) })}
        </p>
        {error && (
          <p className="notice danger" role="alert" style={{ margin: 0 }}>
            <Icon name="warn" size={14} />
            <span>
              <b>{t('library.rename.failed')}</b> {error}
            </span>
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * The three dots of a project card and the menu they open (also on a right-click of the card,
 * through `at`): Open, Rename, Show in folder, Export package and Close project for the open
 * project, Delete. Rename and Delete ask in a dialog first; Delete moves the folder to the recycle
 * bin. The button sits beside the card's own button, so a click on the card still opens the
 * project.
 */
export function ProjectMenu({
  entry,
  current,
  opening,
  at,
  onAt,
}: {
  entry: LibraryEntry;
  /** This project is the open one. */
  current: boolean;
  opening: boolean;
  /** Where the menu is open (viewport pixels), or null. */
  at: MenuAt | null;
  onAt: (at: MenuAt | null) => void;
}) {
  const t = useT();
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const more = useRef<HTMLButtonElement>(null);
  // the place the dots asked for: the menu hangs from the button; any other place is a right-click
  const [fromDots, setFromDots] = useState<MenuAt | null>(null);
  const [dialog, setDialog] = useState<
    'rename' | 'delete' | 'emptyTrash' | 'thumbnail' | 'move' | null
  >(null);
  const jobRunning = useJobs((s) =>
    s.jobs.some((j) => isActive(j) && samePathText(j.project, entry.path)),
  );
  const open = at !== null;
  const onDots = open && at === fromDots;

  const openBelowButton = () => {
    const r = more.current?.getBoundingClientRect();
    if (!r) return;
    const place = { x: r.left, y: r.bottom };
    setFromDots(place);
    onAt(place);
  };
  const close = () => {
    setFromDots(null);
    onAt(null);
  };

  const run = (id: ProjectActionId) => {
    const s = shell.getState();
    if (id === 'open') {
      if (!opening) void s.openProject(entry.path);
    } else if (id === 'remove') void s.removeProject(entry);
    else if (id === 'rename' || id === 'delete' || id === 'thumbnail' || id === 'move')
      setDialog(id);
    else if (id === 'emptyTrash') {
      // what an earlier Empty held is forgotten, so this one's held entries note again
      removal.setState({ held: 0 });
      setDialog(id);
    } else if (id === 'reveal') void s.revealProject(entry);
    else if (id === 'close') s.closeProject();
    else {
      const project = workspace.getState().project;
      if (project) s.setExportFor(project.id);
    }
  };

  const actions = projectActions(entry, { dataRoot, current, jobRunning });
  const items: MenuItem[] = actions.map((a) => {
    const why = a.why ? t(WHY[a.why]) : undefined;
    return {
      id: a.id,
      label: t(LABEL[a.id]),
      icon: ICON[a.id],
      testId: `project-menu-${a.id}`,
      ...(a.id === 'delete' ? { danger: true } : {}),
      // greyed with its reason on a second line
      ...(why !== undefined ? { note: why, disabledReason: why } : {}),
      onSelect: () => {
        run(a.id);
      },
    };
  });
  const menu = {
    label: t('library.menu.label', { project: entry.name }),
    title: entry.name,
    items,
    testId: 'project-menu',
    onClose: close,
  };

  return (
    <>
      <button
        ref={more}
        type="button"
        className="pc-more"
        aria-label={t('library.menu.button', { project: entry.name })}
        aria-haspopup="menu"
        aria-expanded={onDots}
        data-testid="project-menu-button"
        onClick={(e) => {
          e.stopPropagation();
          if (onDots) close();
          else openBelowButton();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || onDots) return;
          e.preventDefault();
          openBelowButton();
        }}
      >
        <Icon name="more" size={16} />
      </button>
      <Menu {...menu} open={onDots} opener={more} anchor="below" />
      {/* a right-click on the card: the same menu at the pointer */}
      {at && !onDots && (
        <MenuAtPoint key={`${String(at.x)},${String(at.y)}`} {...menu} x={at.x} y={at.y} />
      )}
      {dialog === 'rename' && (
        <RenameDialog
          entry={entry}
          onClose={() => {
            setDialog(null);
          }}
          returnTo={() => more.current}
        />
      )}
      {dialog === 'emptyTrash' && (
        <EmptyTrashDialog
          projectId={entry.id}
          onClose={() => {
            setDialog(null);
          }}
          returnTo={() => more.current}
        />
      )}
      {dialog === 'delete' && (
        <DeleteDialog
          entry={entry}
          current={current}
          onClose={() => {
            setDialog(null);
          }}
          returnTo={() => more.current}
        />
      )}
      {dialog === 'thumbnail' && (
        <CoverDialog
          entry={entry}
          current={current}
          onClose={() => {
            setDialog(null);
          }}
          returnTo={() => more.current}
        />
      )}
      {dialog === 'move' && (
        <MoveToFolderDialog
          entry={entry}
          current={current}
          onClose={() => {
            setDialog(null);
          }}
          returnTo={() => more.current}
        />
      )}
    </>
  );
}
