import type { LibraryEntry } from '@aio/schema';
import {
  arrowFocus,
  formatBytes,
  Icon,
  useFocusTrap,
  useT,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { shell, useShell } from '../shell';
import { projectActions, type ProjectActionId, type WhyNot } from './projectMenuModel';

export interface MenuAt {
  x: number;
  y: number;
}

const MENU_W = 232;

const ICON: Record<ProjectActionId, IconName> = {
  open: 'chev-r',
  rename: 'anno',
  reveal: 'folder',
  export: 'download',
  close: 'x',
  delete: 'trash',
};

const LABEL: Record<ProjectActionId, MessageKey> = {
  open: 'library.menu.open',
  rename: 'library.menu.rename',
  reveal: 'library.menu.reveal',
  export: 'library.menu.export',
  close: 'library.menu.close',
  delete: 'library.menu.delete',
};

const WHY: Record<WhyNot, MessageKey> = {
  package: 'library.menu.why.package',
  demo: 'library.menu.why.demo',
  kit: 'library.menu.why.kit',
  outside: 'library.menu.why.outside',
  open: 'library.menu.why.open',
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
  const dlg = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo });
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
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-title"
        data-testid="project-rename"
      >
        {/* Enter in the field renames; the form adds no box of its own (display: contents) */}
        <form className="dlg-form" onSubmit={submit}>
          <div className="dlg-h">
            <Icon name="anno" size={16} />
            <h2 id="project-rename-title">{t('library.rename.title')}</h2>
          </div>
          <div className="dlg-b">
            <input
              className="input"
              type="text"
              autoFocus
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
          </div>
          <div className="dlg-f">
            <span className="grow" />
            <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
              {t('library.cancel')}
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={!next || busy}
              data-testid="project-rename-confirm"
            >
              {busy ? t('library.rename.busy') : t('library.rename.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteDialog({
  entry,
  onClose,
  returnTo,
}: {
  entry: LibraryEntry;
  onClose: () => void;
  returnTo: () => HTMLElement | null;
}) {
  const t = useT();
  const dlg = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  // the safe choice has focus first: Enter on a dialog that just opened deletes nothing
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo, initial: () => keep.current });

  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void shell
      .getState()
      .deleteProject(entry)
      .then((failed) => {
        if (failed === null) onClose();
        else {
          setBusy(false);
          setError(failed);
        }
      });
  };

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-delete-title"
        aria-describedby="project-delete-text"
        data-testid="project-delete"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="project-delete-title" dir="auto">
            {t('library.delete.title', { project: entry.name })}
          </h2>
        </div>
        <div className="dlg-b">
          <p id="project-delete-text" style={{ margin: 0 }}>
            {t('library.delete.text')}
          </p>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>{t('library.delete.folder')}</dt>
            <dd className="mono pm-path">{entry.path}</dd>
            {entry.sizeBytes !== undefined && (
              <>
                <dt>{t('library.delete.size')}</dt>
                <dd className="mono">{formatBytes(entry.sizeBytes)}</dd>
              </>
            )}
          </dl>
          <p className="help" style={{ margin: 0 }}>
            {t('library.delete.restore')}
          </p>
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>
                <b>{t('library.delete.failed')}</b> {error}
              </span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button
            ref={keep}
            type="button"
            className="btn ghost"
            onClick={cancel}
            disabled={busy}
            data-testid="project-delete-cancel"
          >
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={confirm}
            disabled={busy}
            data-testid="project-delete-confirm"
          >
            <Icon name="trash" size={14} />
            {busy ? t('library.delete.busy') : t('library.delete.confirm')}
          </button>
        </div>
      </div>
    </div>
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
  const list = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const open = at !== null;

  // a click elsewhere, a resize, or a scroll that moves the card closes the menu
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const target = e.target as Node | null;
      // the dots button closes it itself on its click
      if (list.current?.contains(target) || more.current?.contains(target)) return;
      onAt(null);
    };
    // Where the card was when the menu opened. A scroll event is reported a frame after the
    // scroll itself, so one that brought the card into view just before a right-click arrives
    // when the menu is already open: the card has not moved since, and the menu stays.
    const anchor = more.current?.getBoundingClientRect();
    const scrolled = (e: Event) => {
      if (list.current?.contains(e.target as Node | null)) return;
      const now = more.current?.getBoundingClientRect();
      const still =
        anchor !== undefined &&
        now !== undefined &&
        Math.abs(now.left - anchor.left) < 1 &&
        Math.abs(now.top - anchor.top) < 1;
      if (!still) onAt(null);
    };
    const away = () => {
      onAt(null);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', away);
    };
  }, [open, onAt]);
  useFocusTrap(list, open, {
    onEscape: () => {
      onAt(null);
    },
    returnTo: () => more.current,
  });

  const openBelowButton = () => {
    const r = more.current?.getBoundingClientRect();
    if (r) onAt({ x: r.right - MENU_W, y: r.bottom + 4 });
  };

  const run = (id: ProjectActionId) => {
    const s = shell.getState();
    if (id === 'open') {
      if (!opening) void s.openProject(entry.path);
    } else if (id === 'rename' || id === 'delete') setDialog(id);
    else if (id === 'reveal') void s.revealProject(entry);
    else if (id === 'close') s.closeProject();
    else {
      const project = workspace.getState().project;
      if (project) s.setExportFor(project.id);
    }
  };

  const actions = projectActions(entry, { dataRoot, current });
  const height = 40 + actions.length * 34 + actions.filter((a) => a.why).length * 14;
  const style = at
    ? {
        left: Math.max(8, Math.min(at.x, window.innerWidth - MENU_W - 8)),
        top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)),
        width: MENU_W,
      }
    : undefined;

  return (
    <>
      <button
        ref={more}
        type="button"
        className="pc-more"
        aria-label={t('library.menu.button', { project: entry.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="project-menu-button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) onAt(null);
          else openBelowButton();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return;
          e.preventDefault();
          openBelowButton();
        }}
      >
        <Icon name="more" size={16} />
      </button>
      {/* beside the card, inside the Projects region (not a portal): the menu is page content */}
      {at && (
        <div
          ref={list}
          className="dmenu"
          role="menu"
          aria-label={t('library.menu.label', { project: entry.name })}
          style={style}
          data-testid="project-menu"
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
          }}
          onContextMenu={(e) => {
            // a right-click inside the menu neither opens the browser's menu nor moves this one
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="dmenu-h faint" dir="auto">
            {entry.name}
          </div>
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={`dmenu-item${a.id === 'open' ? ' primary' : ''}${a.id === 'delete' ? ' danger' : ''}`}
              aria-disabled={a.why ? true : undefined}
              data-testid={`project-menu-${a.id}`}
              onClick={() => {
                if (a.why) return;
                onAt(null);
                run(a.id);
              }}
            >
              <Icon name={ICON[a.id]} size={14} />
              <span>
                {t(LABEL[a.id])}
                {a.why && <small className="dmenu-why">{t(WHY[a.why])}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {dialog === 'rename' &&
        createPortal(
          <RenameDialog
            entry={entry}
            onClose={() => {
              setDialog(null);
            }}
            returnTo={() => more.current}
          />,
          document.body,
        )}
      {dialog === 'delete' &&
        createPortal(
          <DeleteDialog
            entry={entry}
            onClose={() => {
              setDialog(null);
            }}
            returnTo={() => more.current}
          />,
          document.body,
        )}
    </>
  );
}
