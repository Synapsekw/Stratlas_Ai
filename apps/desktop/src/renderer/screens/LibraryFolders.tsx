import type { LibraryFolder } from '@aio/schema';
import { arrowFocus, Icon, useFocusTrap, useT } from '@aio/ui';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { shell } from '../shell';
import { DRAG_TYPE } from './libraryFolderModel';
import './libraryFolders.css';

/** Main's limit on a folder name. */
const NAME_MAX = 60;
const MENU_W = 200;

/** True while the drag carries a project card (another drag, a file say, is not ours). */
const carriesCard = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

/**
 * Makes an element a drop target for project cards: `over` is true while a card hovers it, and
 * `onCard` gets the library id of the card dropped on it. Enter and leave are counted, so moving
 * over the element's own children does not flicker the highlight.
 */
export function useCardDrop(onCard: (projectId: string) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesCard(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesCard(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesCard(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesCard(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id) onCard(id);
    },
  };
  return { over, props };
}

/** A folder name to make or change: one field, Enter saves. */
function FolderNameDialog({
  title,
  initial,
  confirm,
  testId,
  save,
  onClose,
  returnTo,
}: {
  title: string;
  initial: string;
  confirm: string;
  testId: string;
  /** Null when it worked, else the sentence to show. */
  save: (name: string) => Promise<string | null>;
  onClose: () => void;
  returnTo: () => HTMLElement | null;
}) {
  const t = useT();
  const dlg = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(initial);
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
    if (next === initial) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    void save(next).then((failed) => {
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
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
      >
        <form className="dlg-form" onSubmit={submit}>
          <div className="dlg-h">
            <Icon name="folder" size={16} />
            <h2 id={`${testId}-title`}>{title}</h2>
          </div>
          <div className="dlg-b">
            <input
              className="input"
              type="text"
              autoFocus
              maxLength={NAME_MAX}
              aria-label={t('library.folders.name')}
              placeholder={t('library.folders.name')}
              data-testid="folder-name"
              value={name}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            {error && (
              <p className="notice danger" role="alert" style={{ margin: 0 }}>
                <Icon name="warn" size={14} />
                <span>{error}</span>
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
              data-testid="folder-name-confirm"
            >
              {confirm}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Delete a folder: its projects go loose, no file is touched. */
function DeleteFolderDialog({
  folder,
  onClose,
  returnTo,
}: {
  folder: LibraryFolder;
  onClose: () => void;
  returnTo: () => HTMLElement | null;
}) {
  const t = useT();
  const dlg = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo });
  const run = () => {
    setBusy(true);
    setError(null);
    void shell
      .getState()
      .deleteFolder(folder.id)
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
        aria-labelledby="folder-delete-title"
        aria-describedby="folder-delete-text"
        data-testid="folder-delete-dialog"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="folder-delete-title">{t('library.folders.delete')}</h2>
        </div>
        <div className="dlg-b">
          <p id="folder-delete-text" style={{ margin: 0 }}>
            {t('library.folders.delete.text', { folder: folder.name })}
          </p>
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>{error}</span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={run}
            disabled={busy}
            data-testid="folder-delete-confirm"
          >
            {t('library.folders.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** New folder on the Projects toolbar, and the small name dialog it opens. */
export function NewFolderButton({ onCreated }: { onCreated?: () => void }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn"
        data-testid="library-new-folder"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="folder" size={14} />
        {t('library.folders.new')}
      </button>
      {open &&
        createPortal(
          <FolderNameDialog
            title={t('library.folders.new')}
            initial=""
            confirm={t('library.folders.create')}
            testId="folder-new-dialog"
            save={async (name) => {
              const failed = await shell.getState().createFolder(name);
              if (failed === null) onCreated?.();
              return failed;
            }}
            onClose={() => {
              setOpen(false);
            }}
            returnTo={() => btn.current}
          />,
          document.body,
        )}
    </>
  );
}

interface MenuAt {
  x: number;
  y: number;
}

/** One folder in the row: click or Enter opens it, a card dropped on it moves there. */
function FolderTile({
  folder,
  count,
  onOpen,
  onCard,
}: {
  folder: LibraryFolder;
  count: number;
  onOpen: () => void;
  onCard: (projectId: string) => void;
}) {
  const t = useT();
  const tile = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const drop = useCardDrop(onCard);
  const menuOpen = menu !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (e: Event) => {
      if (list.current?.contains(e.target as Node | null)) return;
      setMenu(null);
    };
    const away = () => {
      setMenu(null);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', away);
    };
  }, [menuOpen]);
  useFocusTrap(list, menuOpen, {
    onEscape: () => {
      setMenu(null);
    },
    returnTo: () => tile.current,
  });

  const openMenu = (e: MouseEvent) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    // the menu key and Shift+F10 report no pointer: open under the tile instead
    const r = tile.current?.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    setMenu(keyboard && r ? { x: r.left, y: r.bottom + 4 } : { x: e.clientX, y: e.clientY });
  };

  const items: {
    id: 'open' | 'rename' | 'delete';
    label: string;
    icon: 'chev-r' | 'anno' | 'trash';
  }[] = [
    { id: 'open', label: t('library.menu.open'), icon: 'chev-r' },
    { id: 'rename', label: t('library.folders.rename'), icon: 'anno' },
    { id: 'delete', label: t('library.folders.delete'), icon: 'trash' },
  ];
  const style = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - 150 - 8)),
        width: MENU_W,
      }
    : undefined;

  return (
    <div
      ref={tile}
      className={`ftile${drop.over ? ' over' : ''}`}
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={`${folder.name}, ${count === 1 ? t('library.folders.count.one') : t('library.folders.count', { count })}`}
      data-testid="folder-tile"
      data-folder-id={folder.id}
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node) || list.current?.contains(e.target as Node))
          return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={openMenu}
      {...drop.props}
    >
      <span className="ftile-ic" aria-hidden="true">
        <Icon name="folder" size={16} />
      </span>
      <span className="ftile-name" dir="auto">
        {folder.name}
      </span>
      <span className="ftile-count mono">{count}</span>
      {/* on document.body: menu items inside the role=button tile would read as part of it */}
      {menu &&
        createPortal(
          <div
            ref={list}
            className="dmenu"
            role="menu"
            aria-label={folder.name}
            style={style}
            data-testid="folder-menu"
            onClick={(e) => {
              e.stopPropagation();
            }}
            onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
              e.stopPropagation();
              if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div className="dmenu-h faint" dir="auto">
              {folder.name}
            </div>
            {items.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                className={`dmenu-item${a.id === 'open' ? ' primary' : ''}${a.id === 'delete' ? ' danger' : ''}`}
                data-testid={`folder-menu-${a.id}`}
                onClick={() => {
                  setMenu(null);
                  if (a.id === 'open') onOpen();
                  else setDialog(a.id);
                }}
              >
                <Icon name={a.icon} size={14} />
                <span>{a.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
      {dialog === 'rename' &&
        createPortal(
          <FolderNameDialog
            title={t('library.folders.rename')}
            initial={folder.name}
            confirm={t('library.folders.rename')}
            testId="folder-rename-dialog"
            save={(name) => shell.getState().renameFolder(folder.id, name)}
            onClose={() => {
              setDialog(null);
            }}
            returnTo={() => tile.current}
          />,
          document.body,
        )}
      {dialog === 'delete' &&
        createPortal(
          <DeleteFolderDialog
            folder={folder}
            onClose={() => {
              setDialog(null);
            }}
            returnTo={() => tile.current}
          />,
          document.body,
        )}
    </div>
  );
}

/** The row of folders above the loose cards on All. */
export function FolderRow({
  folders,
  counts,
  dragging,
  onOpen,
  onCard,
}: {
  folders: readonly LibraryFolder[];
  counts: ReadonlyMap<string, number>;
  /** A card is being dragged: the tiles show they take it. */
  dragging: boolean;
  onOpen: (folderId: string) => void;
  onCard: (projectId: string, folderId: string) => void;
}) {
  const t = useT();
  if (folders.length === 0) return null;
  return (
    <div
      className={`frow${dragging ? ' dragging' : ''}`}
      role="group"
      aria-label={t('library.folders.row')}
      data-testid="folder-row"
    >
      {folders.map((f) => (
        <FolderTile
          key={f.id}
          folder={f}
          count={counts.get(f.id) ?? 0}
          onOpen={() => {
            onOpen(f.id);
          }}
          onCard={(id) => {
            onCard(id, f.id);
          }}
        />
      ))}
    </div>
  );
}

/** `‹ All projects` above an open folder; a card dropped on it leaves the folder. */
export function FolderBack({
  dragging,
  onBack,
  onCard,
}: {
  dragging: boolean;
  onBack: () => void;
  onCard: (projectId: string) => void;
}) {
  const t = useT();
  const drop = useCardDrop(onCard);
  return (
    <button
      type="button"
      className={`fback${drop.over ? ' over' : ''}${dragging ? ' dragging' : ''}`}
      data-testid="folder-back"
      onClick={onBack}
      {...drop.props}
    >
      <Icon name="back" size={14} />
      {t('library.folders.all')}
    </button>
  );
}
