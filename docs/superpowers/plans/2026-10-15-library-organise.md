# Library remove, thumbnails and folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every library card can be removed from the library or deleted to the recycle bin, given a cover picture, and put in one level of folders.

**Architecture:** The new per-computer state (hidden cards, folders, placements) lives in a new userData file `library-view.json` (`aio.library-view/1`) behind a `LibraryViewStore` in main; `library:list` filters and decorates entries with it. Covers go into the project folder (`thumbnail.jpg`) when it is a native folder, else into userData `covers/`, served as `aio://cover/<hash>.jpg`. The renderer gets a menu model with the new actions, a Delete dialog per kind of card, a cover picker shared by the wizard and the menu, and a folder row on the Projects screen.

**Tech Stack:** TypeScript, Electron main + React renderer, zod contracts in `@aio/schema`, zustand stores, vitest, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-15-library-organise-design.md`

## Global Constraints

- Worktree `E:\Dev\AIO Software\.claude\worktrees\library-organise`, branch `feat/library-organise`. Never edit the main checkout.
- `library.json` stays `aio.library/1` with `{ schema, paths }`; nothing new is written into it.
- New file userData `library-view.json`, family `aio.library-view/1`, `since: '0.14'`; refused for writing (and read as empty) when newer, through `newerThanThisBuild`.
- Covers: JPEG only, at most 640 px on the long side, at most 512 KB (the `thumbs:put` limit); userData `covers/<sha256(key)>.jpg`.
- Library key: resolved path, lower case on Windows (`sameKey` in `library.ts`); demo projects use `demo:<folder name>`.
- Nothing is deleted for good: `shell.trashItem` only. Main re-checks every delete target on disk.
- Delete is blocked only while the project is open or a job runs in it. Remove is never blocked.
- One folder level; a project is in one folder or loose. HTML5 drag events, no new dependency.
- Renderer never imports `electron` or `node:*`; the renderer names library ids, never paths, for remove, delete, move and thumbnail.
- No em or en dashes in user-facing text. Strings go in `packages/ui/src/i18n/en.ts`.
- Contract change: one row in `docs/architecture/contract-changes.md`.
- e2e: `--workers=1`, one Playwright run at a time, the CI way (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`), `pnpm demo:change --quick` built first.

## Review Focus

1. **A demo removed or deleted comes back after a restart or an update.** Hide by `demo:<id>`, not by path; test in T2 (`applyLibraryView` hides both the bundled path and the working copy of one demo) and e2e in T9.
2. **Delete of an added folder that holds something important** (the data folder itself, userData, the home folder, a drive root, a link). `deletableTarget` refuses each; one unit test per refusal in T4.
3. **Two quick drags or moves at once lose one write.** `LibraryViewStore` serialises writes; T2 test runs two `move` calls without awaiting the first and expects both placements.
4. **A changed cover still shows the old picture** (same URL, browser cache). URLs carry `?v=<mtime>`; T6 test checks the returned URL changes after a second write; T8 e2e checks the card `img` `src` changes.
5. **A `library-view.json` from a newer build** gets overwritten by a hide or a new folder. T2 test: a `/2` file makes every write reject with the update message and the file bytes stay the same.

---

## File structure

| File                                                                         | Responsibility                                                                   | Task   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `packages/schema/src/ipc.ts`                                                 | `LibraryEntry` fields, `LibraryFolder`, seven new channels, `library:delete` doc | T1     |
| `packages/schema/src/versions.ts`                                            | `aio.library-view` row                                                           | T1     |
| `docs/architecture/contract-changes.md`, `docs/release/UPGRADE-POLICY.md`    | contract row; reader-wiring row                                                  | T1     |
| `apps/desktop/src/main/libraryView.ts` (new)                                 | `LibraryViewStore`, `libraryKey`, `applyLibraryView`, folder IPC handlers        | T2     |
| `apps/desktop/src/main/covers.ts` (new)                                      | read side (T2): `coverHash`, `coverFile`, `coverStamp`; write side and IPC (T6)  | T2, T6 |
| `apps/desktop/src/main/library.ts`                                           | `LibraryStore.remove`, `purpose`, `?v=` on thumbnails                            | T2     |
| `apps/desktop/src/main/libraryActions.ts`                                    | deps interface + `library:remove` stub (T2); remove and loosened delete (T4)     | T2, T4 |
| `apps/desktop/src/main/protocol/handler.ts`                                  | `aio://cover/<hash>.jpg`                                                         | T2     |
| `apps/desktop/src/main/journal.ts`                                           | `library:remove`, `library:move` in `READS`                                      | T2     |
| `apps/desktop/src/main/project.ts`                                           | `ProjectRegistry.forgetPackage`                                                  | T2     |
| `apps/desktop/src/main/index.ts`                                             | wiring of every new dep and handler                                              | T2     |
| `apps/desktop/src/renderer/store.ts`                                         | `folders`, `removeProject`, `deleteProject`, `setThumbnail`, folder actions      | T3     |
| `apps/desktop/src/renderer/screens/projectMenuModel.ts`                      | new action ids and rules                                                         | T3     |
| `apps/desktop/src/renderer/screens/ProjectMenu.tsx`                          | dispatch to dialogs; Delete dialog moved out                                     | T3     |
| `apps/desktop/src/renderer/screens/DeleteDialog.tsx` (new)                   | moved verbatim (T3); per-kind text (T5)                                          | T3, T5 |
| `apps/desktop/src/renderer/screens/CoverDialog.tsx` (new)                    | stub (T3); Change thumbnail dialog (T7)                                          | T3, T7 |
| `apps/desktop/src/renderer/screens/MoveToFolderDialog.tsx` (new)             | stub (T3); folder picker (T9)                                                    | T3, T9 |
| `packages/ui/src/i18n/en.ts`                                                 | every new string                                                                 | T3     |
| `apps/desktop/src/renderer/library/cover.ts` (new)                           | resize, built-in covers, current view                                            | T7     |
| `apps/desktop/src/renderer/library/CoverPicker.tsx`, `cover.css` (new)       | picker shared by wizard and dialog                                               | T7     |
| `apps/desktop/src/renderer/builder/NewProjectWizard.tsx`, `builder/model.ts` | cover on the Project step                                                        | T8     |
| `apps/desktop/src/renderer/screens/libraryFolderModel.ts` (new)              | pure grouping, counts, search                                                    | T9     |
| `apps/desktop/src/renderer/screens/LibraryFolders.tsx`, `libraryFolders.css` | tiles row, New folder, folder menu and dialogs                                   | T9     |
| `apps/desktop/src/renderer/screens/Projects.tsx`                             | folder place, drag source, tiles row                                             | T9     |
| e2e: `project-menu.spec.ts`, new `library-remove.spec.ts`                    | remove and delete                                                                | T10    |
| e2e: new `library-covers.spec.ts`                                            | wizard cover, Change thumbnail, package cover                                    | T8     |
| e2e: new `library-folders.spec.ts`                                           | folders, drag, move, search                                                      | T11    |

## Execution DAG

```
T1 contract
 ├─> T2 main: view store, covers read side, wiring      ─┐
 └─> T3 renderer: store, menu model, dialogs, strings   ─┤
                                                         ├─> T4 main delete/remove   ─┐
                                                         ├─> T5 Delete dialog        ─┼─> T10 e2e remove/delete ─┐
                                                         ├─> T6 main covers write    ─┤                          │
                                                         ├─> T7 cover picker+dialog  ─┼─> T8 wizard + covers e2e ─┼─> T12 verify
                                                         └─> T9 folders UI           ─┴─> T11 e2e folders       ─┘
```

| Batch | Tasks (run at once, one message) | Shared files            |
| ----- | -------------------------------- | ----------------------- |
| B1    | T1                               | -                       |
| B2    | T2, T3                           | none (main vs renderer) |
| B3    | T4, T5, T6, T7, T9               | none (see file table)   |
| B4    | T8, T10, T11                     | none (one spec each)    |
| B5    | T12                              | -                       |

T4 needs T2 (deps interface); T5, T7, T9 need T3 (stubs, store, strings); T6 needs T2 (`covers.ts` read side). In B4 the Playwright runs go through the shared lock runner one at a time; writing the specs runs in parallel.

**Critical path:** T1 → T3 → T7 → T8 → T12 (the wizard cover needs the picker, and its e2e is the longest spec).

Packages touched: `@aio/schema` (T1), `@aio/ui` i18n (T3), `@aio/desktop` (T2 to T11). No package depends on a new package.

---

### Task 1: Contract

**Files:**

- Modify: `packages/schema/src/ipc.ts` (`LibraryEntry` :156, channels after `library:delete` :652)
- Modify: `packages/schema/src/versions.ts` (row after `aio.library` :284)
- Modify: `docs/architecture/contract-changes.md`, `docs/release/UPGRADE-POLICY.md` (reader-wiring table, the family count in rule 1)
- Test: `packages/schema/src/ipc.test.ts` (or the file that already tests `LibraryEntry`; add one if none), `packages/schema/src/versions.test.ts`

**Interfaces:**

- Produces (exact):

```ts
import { ProjectPurpose } from './builder';

export const LibraryFolderId = z.string().regex(/^f_[a-z0-9]{10}$/);
export const LibraryFolder = z.object({
  id: LibraryFolderId,
  name: z.string().trim().min(1).max(60),
});
export type LibraryFolder = z.infer<typeof LibraryFolder>;

// LibraryEntry gains:
  /** Per computer: the library folder the card is in; absent when loose. */
  folderId: LibraryFolderId.optional(),
  /** The manifest's purpose when this build knows it (cover colours). */
  purpose: ProjectPurpose.optional(),
  /** A per-computer cover (userData covers/) overrides the project's own picture. */
  customCover: z.boolean().optional(),

const CoverJpeg = z
  .instanceof(Uint8Array)
  .refine((d) => d.byteLength > 3 && d.byteLength <= 512 * 1024, {
    message: 'A cover is a JPEG of at most 512 KB',
  });

'library:remove': { request: z.object({ projectId: ProjectId }).strict(), response: OkOrFailure },
'library:setThumbnail': {
  request: z.object({ projectId: ProjectId, data: CoverJpeg.nullable() }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), thumbnail: z.string().nullable() }),
    Failure,
  ]),
},
'library:folders': {
  request: Empty,
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), folders: z.array(LibraryFolder) }),
    Failure,
  ]),
},
'library:createFolder': {
  request: z.object({ name: z.string().trim().min(1).max(60) }).strict(),
  response: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), folder: LibraryFolder }), Failure]),
},
'library:renameFolder': {
  request: z.object({ folderId: LibraryFolderId, name: z.string().trim().min(1).max(60) }).strict(),
  response: OkOrFailure,
},
'library:deleteFolder': { request: z.object({ folderId: LibraryFolderId }).strict(), response: OkOrFailure },
'library:move': {
  request: z.object({ projectId: ProjectId, folderId: LibraryFolderId.nullable() }).strict(),
  response: OkOrFailure,
},
```

`library:delete` keeps its shape; rewrite its doc comment: "Move a library entry to the recycle bin (never a permanent delete): a project or package in the data folder, a folder or package added to the library, or a demo's working copy. Refuses while a job runs in it."

- [ ] **Step 1: Write the failing tests**

```ts
describe('library contract', () => {
  it('reads an entry with a folder, a purpose and a custom cover', () => {
    const e = LibraryEntry.parse({
      id: 'a',
      name: 'A',
      path: 'x',
      kind: 'native',
      folderId: 'f_abcdefghij',
      purpose: 'survey',
      customCover: true,
    });
    expect(e.folderId).toBe('f_abcdefghij');
  });
  it('refuses a folder id of another shape', () => {
    expect(LibraryFolder.safeParse({ id: '../x', name: 'A' }).success).toBe(false);
  });
  it('takes a null cover (back to the project picture) and refuses one over 512 KB', () => {
    const req = IPC_CONTRACT['library:setThumbnail'].request; // the contract map's real name
    expect(req.safeParse({ projectId: 'a', data: null }).success).toBe(true);
    expect(req.safeParse({ projectId: 'a', data: new Uint8Array(512 * 1024 + 1) }).success).toBe(
      false,
    );
  });
});
```

and in `versions.test.ts`: `expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.library-view')).toMatchObject({ version: 1, home: 'userData', since: '0.14' })`.

- [ ] **Step 2: Run** `pnpm --filter @aio/schema exec vitest run` and see the new tests fail.
- [ ] **Step 3: Implement** the schema above and the registry row:

```ts
// per-computer library state beside library.json: hidden cards, folders (library organise, 15 Oct 2026)
{ family: 'aio.library-view', version: 1, home: 'userData', where: 'library-view.json', since: '0.14' },
```

Update any channel list snapshot the schema tests keep. Add the contract row (date 2026-10-15): "IPC (additive): `LibraryEntry` gains `folderId?`, `purpose?`, `customCover?`; new `LibraryFolder`; new `library:remove`, `library:setThumbnail` (JPEG ≤ 512 KB or null), `library:folders`, `library:createFolder`, `library:renameFolder`, `library:deleteFolder`, `library:move`; `library:delete` also takes packages, kit exports, added folders and demo working copies; protocol host `aio://cover/<hash>.jpg`; userData `library-view.json` (`aio.library-view/1`) and `covers/`." Add the `library-view.json` row to the UPGRADE-POLICY reader table ("read as empty; a change gets the update message | No") and bump the family count.

- [ ] **Step 4: Run** `pnpm --filter @aio/schema exec vitest run` and `pnpm typecheck`: PASS (desktop still compiles: the new fields are optional and new channels have no handler yet; if a test asserts that every channel has a handler, T2 registers the stubs, so run that test after T2).
- [ ] **Step 5: Commit** `feat(schema): library remove, covers and folders channels`

---

### Task 2: Main: view store, covers read side, wiring

**Files:**

- Create: `apps/desktop/src/main/libraryView.ts`, `apps/desktop/src/main/libraryView.test.ts`
- Create: `apps/desktop/src/main/covers.ts`, `apps/desktop/src/main/covers.test.ts`
- Modify: `apps/desktop/src/main/library.ts` (`LibraryStore` :19, `summarise` :164, thumbnail URLs :206, :235, :265), `library.test.ts`
- Modify: `apps/desktop/src/main/libraryActions.ts` (deps interface :164, stub only), `apps/desktop/src/main/project.ts` (`ProjectRegistry`)
- Modify: `apps/desktop/src/main/protocol/handler.ts` (`AioRoots`, new host), `handler.test.ts`
- Modify: `apps/desktop/src/main/journal.ts` (`READS` :245)
- Modify: `apps/desktop/src/main/index.ts` (:324, :805-850, :872, :1625-1630, :1956)

**Interfaces:**

- Consumes: T1 schema.
- Produces:

```ts
// libraryView.ts
export const LIBRARY_VIEW_SCHEMA = 'aio.library-view/1';
export interface LibraryView { hidden: string[]; folders: LibraryFolder[]; placed: Record<string, string> }
export interface LibraryViewStore {
  read(): Promise<{ view: LibraryView; newer: string | null }>;
  hide(key: string): Promise<void>;
  unhide(key: string): Promise<void>;
  /** After a delete: drop the key from hidden and placed. */
  forget(key: string): Promise<void>;
  createFolder(name: string): Promise<LibraryFolder>;
  renameFolder(id: string, name: string): Promise<void>;
  /** Projects in it become loose. */
  deleteFolder(id: string): Promise<void>;
  move(key: string, folderId: string | null): Promise<void>;
}
export function createLibraryViewStore(file: string): LibraryViewStore;
/** `demo:<folder name>` for a demo, else the resolved path (lower case on Windows). */
export function libraryKey(path: string, demo: boolean): string;
export function entryKey(e: LibraryEntry): string; // libraryKey(e.path, e.demo !== undefined)
export async function applyLibraryView(
  entries: LibraryEntry[],
  view: LibraryView,
  coverStamp: (key: string) => Promise<{ hash: string; mtimeMs: number } | null>,
): Promise<LibraryEntry[]>;
export function registerLibraryFoldersIpc(d: {
  handle: Handle;
  view: LibraryViewStore;
  projects: { path(id: string): string | undefined };
  isDemo: (path: string) => Promise<boolean>;
}): void; // library:folders, createFolder, renameFolder, deleteFolder, move (done here, fully)

// covers.ts (read side)
export const coverHash = (key: string) => sha256 hex of key;
export const coverFile = (dir: string, key: string) => join(dir, `${coverHash(key)}.jpg`);
export async function coverStamp(dir: string, key: string): Promise<{ hash: string; mtimeMs: number } | null>;
export function registerCoverIpc(d: CoverDeps): void; // T2: library:setThumbnail answers notYet('Changing the thumbnail')
export interface CoverDeps {
  handle: Handle;
  projects: { path(id: string): string | undefined; package(id: string): unknown };
  isDemo: (path: string) => Promise<boolean>;
  coversDir: () => string;
}

// library.ts
export interface LibraryStore { paths(); add(path); remove(path: string): Promise<void> }

// libraryActions.ts: LibraryActionsDeps gains
  view: Pick<LibraryViewStore, 'hide' | 'forget'>;
  store: Pick<LibraryStore, 'paths' | 'remove'>;
  /** Working copy of a demo entry (userData demo/<id>) or null when none; undefined: not a demo. */
  demoCopy?: (path: string) => Promise<string | null | undefined>;
  /** Folders never deleted, nor any folder holding one: userData, home, app, resources. */
  guardRoots: () => string[];
  dropCover?: (key: string) => Promise<void>;
  forgetPackage?: (projectId: string) => void;
// and registers 'library:remove' as notYet('Remove from library') (T4 replaces it)

// project.ts
ProjectRegistry.forgetPackage(id: string): void // drops the opened package; the id stays known
```

- [ ] **Step 1: Write the failing tests** (`libraryView.test.ts`, temp dir per test):

```ts
it('starts empty when there is no file', async () => {
  expect((await store.read()).view).toEqual({ hidden: [], folders: [], placed: {} });
});
it('hides, un-hides and forgets by key', ...);           // hide twice keeps one entry
it('creates, renames and deletes a folder; its projects go loose', ...);
it('refuses a second folder of the same name, case ignored', ...);  // rejects 'A folder called "Yard" already exists.'
it('moves to a folder and back to loose', ...);
it('keeps both moves made at once', async () => {
  const f = await store.createFolder('A');
  await Promise.all([store.move('k1', f.id), store.move('k2', f.id)]);
  expect((await store.read()).view.placed).toEqual({ k1: f.id, k2: f.id });
});
it('refuses every write to a newer file and leaves it as it was', async () => {
  await writeFile(file, JSON.stringify({ schema: 'aio.library-view/2' }));
  const before = await readFile(file);
  await expect(store.hide('k')).rejects.toThrow(/newer version/);
  expect(await readFile(file)).toEqual(before);
  expect((await store.read()).view.hidden).toEqual([]);
});
it('reads a broken file as empty and says so in the log', ...);
it('keys a demo by its folder name, so the bundled folder and the working copy are one card', () => {
  expect(libraryKey('C:\\App\\resources\\demo\\survey-demo', true)).toBe('demo:survey-demo');
  expect(libraryKey('C:\\Users\\a\\AppData\\Q\\demo\\survey-demo', true)).toBe('demo:survey-demo');
});
describe('applyLibraryView', () => {
  it('drops hidden cards, a hidden demo whichever path it lists by', ...);
  it('sets folderId only for a folder that exists', ...);
  it('prefers a custom cover and marks it', async () => {
    const [e] = await applyLibraryView([entry({ thumbnail: 'aio://project/a/thumbnail.jpg?v=1' })], empty, async () => ({ hash: 'ab', mtimeMs: 7 }));
    expect(e).toMatchObject({ thumbnail: 'aio://cover/ab.jpg?v=7', customCover: true });
  });
});
describe('folders IPC', () => { /* collectHandlers(...) from notYet.ts: create then list; move by projectId; unknown projectId fails with "Reload the library" */ });
```

`covers.test.ts`: `coverStamp` null when missing, hash and mtime when present. `library.test.ts`: `remove` drops a path (case ignored on Windows); a listed native entry carries `purpose` and a thumbnail URL ending `?v=<mtimeMs>`. `handler.test.ts`: `aio://cover/<64 hex>.jpg` serves the file, `aio://cover/../x.jpg` and `aio://cover/abc.png` are 404.

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/libraryView.test.ts src/main/covers.test.ts src/main/library.test.ts src/main/protocol/handler.test.ts`: FAIL.
- [ ] **Step 3: Implement.** Store sketch:

```ts
const ViewFile = z.object({
  schema: z.literal(LIBRARY_VIEW_SCHEMA),
  hidden: z.array(z.string()).default([]),
  folders: z.array(LibraryFolder).default([]),
  placed: z.record(z.string(), z.string()).default({}),
});
export function createLibraryViewStore(file: string): LibraryViewStore {
  let chain: Promise<unknown> = Promise.resolve();
  async function load() { /* readJson; newerThanThisBuild(raw, 'aio.library-view', 'library-view.json'); safeParse; as library.ts load() */ }
  function write(change: (v: LibraryView) => LibraryView | Promise<LibraryView>): Promise<void> {
    const next = chain.then(async () => {
      const { view, newer } = await load();
      if (newer) throw new Error(newer);
      await writeJsonAtomic(file, { schema: LIBRARY_VIEW_SCHEMA, ...(await change(view)) });
    });
    chain = next.catch(() => undefined);
    return next;
  }
  ...
}
const newFolderId = () => `f_${randomBytes(5).toString('hex')}`; // 10 hex characters
```

Handler host: `if (url.host === 'cover') { const [name, ...rest] = segments; if (!name || rest.length || !/^[0-9a-f]{64}\.jpg$/.test(name) || !roots.coversDir) return status(404); return serveFile(join(roots.coversDir(), name), req); }` (no `KEEP`: the URL carries `?v=`).

`library.ts`: `summarise` sets `out.purpose = projectPurpose(m)` when defined; thumbnail URLs get `?v=${String(Math.round(mtimeMs))}` (folder: `stat` of the file; package: the package file's `mtimeMs`).

`journal.ts`: add `'library:remove'`, `'library:move'` to `READS` (they write userData only). `library:setThumbnail` stays a writer.

`index.ts`:

```ts
const libraryView = createLibraryViewStore(join(app.getPath('userData'), 'library-view.json'));
const coversDir = () => join(app.getPath('userData'), 'covers');
const isDemoPath = async (path: string) => { /* the isDemo body now inline at :840, moved here and reused */ };
const listView = async (entries: LibraryEntry[]) =>
  applyLibraryView(entries, (await libraryView.read()).view, (key) => coverStamp(coversDir(), key));
handle('library:list', async () => { ...; return listView(markDemoEntries(entries, demos)); });
handle('library:add', async ({ path }) => {
  const r = await addToLibrary(path, library, registry);
  if (r.ok) await libraryView.unhide(libraryKey(r.entry.path, await isDemoPath(r.entry.path))).catch(() => undefined);
  return r;
});
// project:open of a package (:872): also unhide its key after library.add
// globe library (:1625): wrap with markDemoEntries + listView so hidden cards leave the globe too
registerLibraryFoldersIpc({ handle, view: libraryView, projects: registry, isDemo: isDemoPath });
registerCoverIpc({ handle, projects: registry, isDemo: isDemoPath, coversDir });
registerLibraryActionsIpc({ ...existing, isDemo: isDemoPath, view: libraryView, store: library,
  demoCopy: async (path) => (await isDemoPath(path)) ? demoCopyIfAny(path) : undefined,
  guardRoots: () => [app.getPath('userData'), app.getPath('home'), app.getAppPath(), process.resourcesPath],
  dropCover: (key) => rm(coverFile(coversDir(), key), { force: true }),
  forgetPackage: (id) => { registry.forgetPackage(id); } });
// createAioHandler: coversDir
```

`demoCopyIfAny(path)`: `join(demoCopyRoot(), basename(path))` when that folder holds `manifest.json`, else null (a small exported helper in `demo.ts` is fine: `demoWorkingCopy(path, copyRoot)` with its own test in `demo.test.ts`).

- [ ] **Step 4: Run** the four test files, then `pnpm --filter @aio/desktop exec vitest run src/main` and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): library view store, cover folder and wiring`

---

### Task 3: Renderer: store, menu model, dialogs skeleton, strings

**Files:**

- Modify: `apps/desktop/src/renderer/store.ts` (:84, :134-160, :272, :410), `store.test.ts`
- Modify: `apps/desktop/src/renderer/screens/projectMenuModel.ts`, `projectMenuModel.test.ts`
- Modify: `apps/desktop/src/renderer/screens/ProjectMenu.tsx` (ICON/LABEL/WHY :26-53, `DeleteDialog` :167 moved out, `run` :355), `ProjectMenu.test.tsx`
- Create: `apps/desktop/src/renderer/screens/DeleteDialog.tsx` (the current `DeleteDialog`, moved unchanged)
- Create: `apps/desktop/src/renderer/screens/CoverDialog.tsx`, `MoveToFolderDialog.tsx` (stubs)
- Modify: `packages/ui/src/i18n/en.ts` (:250-275)

**Interfaces:**

- Consumes: T1 schema.
- Produces:

```ts
// store.ts (Shell state and actions)
folders: LibraryFolder[];                      // loaded with loadLibrary (library:folders)
removeProject: (entry: LibraryEntry) => Promise<string | null>;   // sets libraryNotice on success
libraryNotice: string | null; dismissLibraryNotice: () => void;
deleteProject: (entry: LibraryEntry) => Promise<string | null>;   // unchanged guard for the open project
setThumbnail: (projectId: string, data: Uint8Array | null) => Promise<string | null>;
createFolder: (name: string) => Promise<string | null>;
renameFolder: (folderId: string, name: string) => Promise<string | null>;
deleteFolder: (folderId: string) => Promise<string | null>;
moveToFolder: (entry: LibraryEntry, folderId: string | null) => Promise<string | null>;
// every action reloads the library (and folders) after the call, error string or null

// projectMenuModel.ts
export type ProjectActionId =
  'open' | 'rename' | 'reveal' | 'thumbnail' | 'move' | 'emptyTrash' | 'export' | 'close' | 'remove' | 'delete';
export type WhyNot = 'package' | 'demo' | 'kit' | 'outside' | 'open' | 'job';
export function projectActions(entry: LibraryEntry, o: { dataRoot: string; current: boolean; jobRunning: boolean }): ProjectAction[];
// order: open, rename(fixed), reveal, thumbnail, move, emptyTrash, export?, close?, remove, delete(open ?? job)

// dialog props shared by DeleteDialog, CoverDialog, MoveToFolderDialog
export interface EntryDialogProps { entry: LibraryEntry; current: boolean; onClose: () => void; returnTo: () => HTMLElement | null }
```

Stubs: `export function CoverDialog(p: EntryDialogProps) { useEffect(() => { p.onClose(); }, [p]); return null; }` and the same for `MoveToFolderDialog`; T7 and T9 replace them.

`ProjectMenu` computes `jobRunning` with `useJobs((s) => s.jobs.some((j) => isActive(j) && samePathText(j.project, entry.path)))` (`isActive` from `../jobs`; `samePathText` compares with case and slash folded, the way `norm` in `projectMenuModel.ts` does: export a `samePathText(a, b)` there). `run`: `'remove'` calls `s.removeProject(entry)` and closes the menu; `'thumbnail' | 'move' | 'delete' | 'rename'` open their dialog.

Strings (en.ts, all new unless marked):

```ts
'library.menu.remove': 'Remove from library',
'library.menu.thumbnail': 'Change thumbnail',
'library.menu.move': 'Move to folder',
'library.menu.why.job': 'A job is running in it',
'library.removed': '{project} was removed from the library. Its files stay in {path}. Add project folder brings it back.',
'library.removed.package': '{project} was removed from the library. The file stays in {path}. Open package brings it back.',
'library.removed.demo': '{project} was removed from the library. Add project folder on its folder brings it back.',
'library.delete.text.folder': (existing 'library.delete.text', kept)
'library.delete.text.package': 'The package file moves to the recycle bin.',
'library.delete.text.kit': 'The kit export folder moves to the recycle bin with everything in it.',
'library.delete.text.demo': 'The working copy of this demo moves to the recycle bin and the demo leaves the library. The demo that ships with the app is not touched.',
'library.delete.text.demoNone': 'Nothing of this demo is on disk outside the app. It leaves the library.',
'library.delete.file': 'File',
'library.cover.title': 'Change thumbnail',
'library.cover.upload': 'Upload an image',
'library.cover.builtin': 'Built-in covers',
'library.cover.view': 'Use current view',
'library.cover.view.why': 'Open the 3D view first',
'library.cover.none': 'No cover',
'library.cover.reset': "Use the project's own picture",
'library.cover.save': 'Save',
'library.cover.failed': 'The thumbnail was not changed.',
'library.cover.badImage': 'This file is not an image the app can read.',
'library.folders.new': 'New folder',
'library.folders.all': 'All projects',
'library.folders.loose': 'No folder',
'library.folders.count': '{count} projects',
'library.folders.count.one': '1 project',
'library.folders.empty': 'No projects in this folder yet. Drag a card here or use Move to folder.',
'library.folders.rename': 'Rename folder',
'library.folders.delete': 'Delete folder',
'library.folders.delete.text': 'The projects in {folder} stay in the library without a folder. No file is touched.',
'library.folders.name': 'Folder name',
'library.folders.create': 'Create',
'library.move.title': 'Move {project} to a folder',
'library.move.confirm': 'Move',
```

- [ ] **Step 1: Write the failing tests.** `projectMenuModel.test.ts`, replacing the two "greys Rename and Delete" tests:

```ts
it('offers Remove and Delete for every kind of card', () => {
  for (const e of [pkg, encrypted, demo, kit, outside, inData]) {
    const a = projectActions(e, { dataRoot, current: false, jobRunning: false });
    expect(a.find((x) => x.id === 'remove')).toEqual({ id: 'remove' });
    expect(a.find((x) => x.id === 'delete')).toEqual({ id: 'delete' });
  }
});
it('holds Delete back on the open project and while a job runs, never Remove', ...);
it('still greys Rename for a package, a demo, a kit export and a folder from elsewhere', ...);
it('offers Change thumbnail and Move to folder for every card', ...);
```

`store.test.ts` (fake bridge as the file already does): `removeProject` calls `library:remove` with the id, reloads, sets `libraryNotice` from `library.removed.package` for a package; `moveToFolder(entry, null)` sends `folderId: null`; `loadLibrary` fills `folders`; a failing `library:folders` keeps the library and sets `libraryError`. `ProjectMenu.test.tsx`: the menu lists Remove from library and Delete for a package card; clicking Remove calls the store and closes the menu.

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/store.test.ts src/renderer/screens`: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. `deleteProject` keeps the open-project guard. The Projects screen shows `libraryNotice` with the existing `notice` style and a Dismiss button: that one line in `Projects.tsx` belongs to T9; until then the notice shows nowhere, which is fine on the branch.
- [ ] **Step 4: Run** the same tests and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): library menu gains remove, thumbnail and move`

---

### Task 4: Main: remove and the loosened delete

**Files:**

- Modify: `apps/desktop/src/main/libraryActions.ts` (`managed` :188, `library:delete` :219, the `library:remove` stub), `libraryActions.test.ts`

**Interfaces:**

- Consumes: T2 `LibraryActionsDeps` fields, `libraryKey`, `managedProjectFolder` (:57).
- Produces:

```ts
export type DeleteTarget =
  | { ok: true; path: string; what: 'folder' | 'package' | 'demo-copy' | 'nothing' }
  | { ok: false; error: string };
export async function deletableTarget(o: {
  path: string; // the library entry's path
  dataRoot: string;
  listed: string[]; // library.json paths
  demoCopy: string | null | undefined;
  guardRoots: string[];
}): Promise<DeleteTarget>;
```

Rules, in order: demo (`demoCopy !== undefined`): `demo-copy` when the copy exists, else `nothing`. A path directly in `<dataRoot>/projects`: a `.aio` file is `package`; a folder goes through `managedProjectFolder`. Any other path must be in `listed` (`samePath`), and then: not a link (`lstat`), not a filesystem root (`dirname(p) === p`), not equal to or an ancestor of `dataRoot` or any guard root; a `.aio` file is `package`; a folder must pass `detectFolder` (`native` or a kit kind) and is `folder`. Everything else fails with a sentence naming the path.

`library:remove`: path from `projects.path(id)` (unknown id fails "Reload the library"), `view.hide(libraryKey(path, isDemo))`; a write failure (newer file) is returned as the failure.

`library:delete`: target as above; a `folder` target with `jobRunningIn` fails with the current sentence; `release` for folders; `deleteProject(target.path, deps)` for folder, package and demo-copy (`nothing` skips the trash); then, best effort and logged on failure: `store.remove(path)`, `view.forget(key)`, `dropCover(key)`, `forgetPackage(id)`, and for a demo `view.hide(key)` so the bundled demo stays out.

- [ ] **Step 1: Write the failing tests** (temp dirs; `trash` a fake that renames into a bin dir as `project-menu.spec.ts` does):

```ts
it('deletes a package file in the data folder', ...);
it('deletes a folder added from elsewhere that holds a manifest', ...);
it('deletes a kit export folder added from elsewhere', ...);         // detectFolder kind 'road' via road.json
it('refuses a folder that is not in library.json', ...);
it('refuses a link to a folder', ...);                               // symlink 'junction' on Windows
it('refuses the data folder, a folder that holds it, userData and the home folder', ...);
it('refuses a drive root', ...);                                     // path.parse(tmp).root
it('trashes a demo working copy and hides the demo', ...);
it('hides a demo that has no working copy and trashes nothing', ...);
it('removes by hiding the key and touches no file', ...);
it('drops the path from library.json, the hidden list, the folder and the cover after a delete', ...);
it('keeps refusing while a job runs in the folder', ...);            // existing test, kept
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/libraryActions.test.ts`: FAIL.
- [ ] **Step 3: Implement** `deletableTarget` and the two handlers. Update the file's top comment (it says packages and demos are refused).
- [ ] **Step 4: Run** the test file and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): remove and delete any library card`

---

### Task 5: Delete dialog per kind of card

**Files:**

- Modify: `apps/desktop/src/renderer/screens/DeleteDialog.tsx`
- Create: `apps/desktop/src/renderer/screens/deleteText.ts`, `deleteText.test.ts`

**Interfaces:**

- Consumes: T3 `EntryDialogProps`, strings.
- Produces: `export function deleteText(entry: LibraryEntry): { text: MessageKey; label: MessageKey }` (label `library.delete.folder` or `library.delete.file`).

- [ ] **Step 1: Failing test:** `deleteText` gives `library.delete.text.package` and `library.delete.file` for a package; `.kit` for `kind: 'road'`; `.demo` for a demo; the existing folder text for a native folder (in the data folder or not).
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/screens/deleteText.test.ts`: FAIL.
- [ ] **Step 3: Implement** and use it in `DeleteDialog`: text by kind, the path always in full in `.pm-path`, the size row as now. Keep `data-testid="project-delete"`, `project-delete-confirm`, the safe button focused first. The demo case cannot tell here whether a copy exists; it shows `.demo` text and the path; main answers `nothing` silently.
- [ ] **Step 4: Run** the test and `src/renderer/screens`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): the delete confirm says what moves to the recycle bin`

---

### Task 6: Main: write covers

**Files:**

- Modify: `apps/desktop/src/main/covers.ts` (replace the `library:setThumbnail` stub), `covers.test.ts`

**Interfaces:**

- Consumes: T2 `CoverDeps`, `coverFile`, `libraryKey`, `detectFolder` (`library.ts` :156), `assertWritable` (`realDataGuard.ts`).
- Produces: `export async function setCover(o: { id: string; path: string; isPackage: boolean; demo: boolean; coversDir: string; data: Uint8Array | null }): Promise<IpcResponse<'library:setThumbnail'>>`.

Behaviour: `data` must start `FF D8 FF` ("A cover must be a JPEG image."). Target is the project folder when not a package, not a demo, not a link, and `detectFolder(path) === 'native'`: write `thumbnail.jpg` atomically (temp file in the folder, then rename), `assertWritable` first, then remove any custom cover for its key (the folder picture now wins). Otherwise write `coverFile(coversDir, key)` atomically (`mkdir -p` first). `data: null` removes the custom cover only (a folder's `thumbnail.jpg` is never removed) and answers the project's own URL or null. The answer is the new URL with `?v=<mtimeMs>`.

Before writing: check whether the journal tracks `thumbnail.jpg` (`grep -n "thumbnail" apps/desktop/src/main/journal.ts`). If it does, wrap `library:setThumbnail` in `journal.ts` the way `library:rename` is wrapped (:1068) so the change is the app's own; note it in the commit.

- [ ] **Step 1: Failing tests:**

```ts
it('writes thumbnail.jpg into a native project folder and answers a fresh URL', ...);
it('writes a package cover into the covers folder, never into the package', ...);   // package bytes unchanged
it('writes a kit export and a demo cover into the covers folder', ...);
it('answers a different URL after a second write', ...);                          // Review Focus 4
it('refuses bytes that are not a JPEG', ...);
it('null removes the custom cover and leaves thumbnail.jpg alone', ...);
it('a folder cover removes an older custom cover of the same key', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/covers.test.ts`: FAIL.
- [ ] **Step 3: Implement.** The IPC handler: unknown id fails "Reload the library"; resolves `isPackage` (`projects.package(id) !== undefined || path ends .aio`) and `demo` (`isDemo(path)`).
- [ ] **Step 4: Run** the test and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): write project covers`

---

### Task 7: Cover picker and the Change thumbnail dialog

**Files:**

- Create: `apps/desktop/src/renderer/library/cover.ts`, `cover.test.ts`
- Create: `apps/desktop/src/renderer/library/CoverPicker.tsx`, `apps/desktop/src/renderer/library/cover.css`
- Modify: `apps/desktop/src/renderer/screens/CoverDialog.tsx` (replace the stub)

**Interfaces:**

- Consumes: T3 `setThumbnail`, `EntryDialogProps`, strings; `captureSnapshot` (`renderer/exports/exports.ts` :133), `getActiveStage` (`@aio/engine`).
- Produces:

```ts
export const COVER_MAX = 640;
export const COVER_BYTES = 512 * 1024;
export type BuiltinCoverId = 'contours' | 'grid' | 'ridge' | 'dots';
export const BUILTIN_COVERS: readonly BuiltinCoverId[];
export type CoverChoice =
  | { kind: 'builtin'; id: BuiltinCoverId }
  | { kind: 'image'; data: Uint8Array; url: string } // url: object URL for the preview
  | { kind: 'none' } // wizard: no cover
  | { kind: 'reset' }; // dialog: back to the project's own picture
export function fitCover(w: number, h: number, max?: number): { width: number; height: number };
export function coverPalette(
  p: ProjectPurpose | undefined,
  kind?: LibraryEntry['kind'],
): { bg: string; line: string; accent: string };
export async function imageToCoverJpeg(source: Blob | ImageBitmap): Promise<Uint8Array>; // throws on undecodable
export async function builtinCoverJpeg(
  id: BuiltinCoverId,
  palette: ReturnType<typeof coverPalette>,
): Promise<Uint8Array>;
export function canUseCurrentView(): boolean; // getActiveStage() !== null
export async function currentViewJpeg(): Promise<Uint8Array | null>; // null without a stage; never navigates
/** Bytes to send for a choice: null for 'reset', undefined for 'none'. */
export async function coverBytes(
  c: CoverChoice,
  palette: ReturnType<typeof coverPalette>,
): Promise<Uint8Array | null | undefined>;

export function CoverPicker(p: {
  palette: ReturnType<typeof coverPalette>;
  value: CoverChoice;
  onChange: (c: CoverChoice) => void;
  allowNone?: boolean;
  allowReset?: boolean;
  currentView?: boolean;
}): JSX.Element;
```

`imageToCoverJpeg`: `createImageBitmap`, `OffscreenCanvas` (or a canvas) at `fitCover`, `convertToBlob({ type: 'image/jpeg', quality: 0.85 })`, again at 0.7 when over `COVER_BYTES`. `currentViewJpeg` checks `getActiveStage()` first and only then calls `captureSnapshot(false)` (which would otherwise navigate to the scene), then `imageToCoverJpeg(new Blob([png]))`. Palette by purpose: survey amber, construction blue, vertical-asset teal, confined-space violet, data-fusion green, road slate; kit kinds map `volumetric→survey`, `road→road`, `aik→vertical-asset`, `twin→data-fusion`; none: neutral grey. Use the app's existing colour tokens where they exist.

`CoverPicker`: an `<input type="file" accept="image/*" data-testid="cover-upload">` behind an "Upload an image" button; four built-in swatches (`data-testid="cover-builtin-<id>"`, `aria-pressed`); "Use current view" (`cover-current-view`, greyed with `library.cover.view.why` when `currentView` is false or no stage); "No cover" / "Use the project's own picture" when allowed; a 16:9 preview. A bad file shows `library.cover.badImage` under the picker.

`CoverDialog`: `role="dialog"`, `data-testid="cover-dialog"`, focus trap as `RenameDialog`; palette from `entry.purpose` and `entry.kind`; `allowReset` when `entry.customCover`; `currentView` when `current`; Save (`cover-save`) calls `shell.getState().setThumbnail(entry.id, bytes)`; an error stays in the dialog.

- [ ] **Step 1: Failing tests** (`cover.test.ts`, pure parts):

```ts
it('fits a wide image to 640 across and keeps a small one as it is', () => {
  expect(fitCover(4000, 3000)).toEqual({ width: 640, height: 480 });
  expect(fitCover(300, 200)).toEqual({ width: 300, height: 200 });
  expect(fitCover(1000, 4000)).toEqual({ width: 160, height: 640 });
});
it('colours a kit export like its project type, and an unknown purpose neutral', ...);
it('sends nothing for No cover and null for the project picture', async () => {
  expect(await coverBytes({ kind: 'none' }, pal)).toBeUndefined();
  expect(await coverBytes({ kind: 'reset' }, pal)).toBeNull();
});
it('says no current view while no stage is active', () => { expect(canUseCurrentView()).toBe(false); });
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/library`: FAIL.
- [ ] **Step 3: Implement.** Load `impeccable` / `frontend-design` before the picker UI. Drawing (canvas) is covered by the T8 e2e.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): cover picker and Change thumbnail`

---

### Task 8: Wizard cover and the covers e2e

**Files:**

- Modify: `apps/desktop/src/renderer/builder/model.ts` (`WizardForm` :13), its test file if one covers `WizardForm` defaults
- Modify: `apps/desktop/src/renderer/builder/NewProjectWizard.tsx` (form state :69, Project step `step === 0` :314, `create` :224)
- Create: `apps/desktop/e2e/library-covers.spec.ts`

**Interfaces:**

- Consumes: T7 `CoverPicker`, `CoverChoice`, `coverBytes`, `coverPalette`; T3 `setThumbnail`; T6 handler.
- Produces: `WizardForm.cover: CoverChoice` (default `{ kind: 'builtin', id: 'contours' }`).

In `create`, after `await builder.getState().created(r.value.path)`: `const id = workspace.getState().project?.id; const bytes = await coverBytes(form.cover, coverPalette(form.purpose)); if (id && bytes) { const err = await shell.getState().setThumbnail(id, bytes); if (err) /* builder importResult notice with library.cover.failed */ }`. The cover never blocks the project being created. The picker sits under the type cards with `data-testid="wizard-cover"`, palette following the chosen purpose.

- [ ] **Step 1: Write the e2e** (`library-covers.spec.ts`, synthetic data root as `project-menu.spec.ts` builds it; a tiny PNG written in the test):

```ts
test('the wizard writes the chosen cover into the new project', ...);
// new-project, name it, pick cover-builtin-grid, finish the wizard with a typed origin as builder.spec.ts does;
// thumbnail.jpg exists in the new folder, starts FF D8 FF, is ≤ 640 px (read the JPEG SOF0 size);
// Projects: the card's img src starts aio://project/ and carries ?v=
test('Change thumbnail on a project uploads an image and the card shows it at once', ...);
// right-click, project-menu-thumbnail, setInputFiles(cover-upload), cover-save; img src changed
test('a package gets a cover on this computer only; the package file is unchanged', ...);
// package fixture as package.spec.ts makes one; sha256 of the .aio before == after; src starts aio://cover/;
// Change thumbnail again shows "Use the project's own picture"; using it brings the package picture back
test('Use current view is greyed until the 3D view has been open', ...);
```

- [ ] **Step 2: Run** it the CI way and see it fail: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/library-covers.spec.ts --workers=1` (from `apps/desktop`, after `pnpm build` of the desktop app as the e2e README says).
- [ ] **Step 3: Implement** the wizard part.
- [ ] **Step 4: Run** the spec again (and `--repeat-each=3` once), then `e2e/builder.spec.ts` (the wizard test at :111 must still pass with the default cover): PASS. Look at a screenshot of the wizard's Project step at 1100 x 720.
- [ ] **Step 5: Commit** `feat(desktop): pick a cover in the new project wizard`

---

### Task 9: Folders on the Projects screen

**Files:**

- Create: `apps/desktop/src/renderer/screens/libraryFolderModel.ts`, `libraryFolderModel.test.ts`
- Create: `apps/desktop/src/renderer/screens/LibraryFolders.tsx`, `apps/desktop/src/renderer/screens/libraryFolders.css`
- Modify: `apps/desktop/src/renderer/screens/MoveToFolderDialog.tsx` (replace the stub)
- Modify: `apps/desktop/src/renderer/screens/Projects.tsx` (`ProjectCard` :80, `ProjectsScreen` :345, `shown` :368, grid :496)

**Interfaces:**

- Consumes: T3 store (`folders`, folder actions, `moveToFolder`, `libraryNotice`), strings.
- Produces:

```ts
export type LibraryPlace = { kind: 'all' } | { kind: 'folder'; id: string };
export const DRAG_TYPE = 'application/x-quadrion-project';
export function folderCounts(entries: readonly LibraryEntry[]): Map<string, number>;
/** A search spans every folder; otherwise All shows loose cards, a folder its own. */
export function visibleEntries(
  entries: readonly LibraryEntry[],
  place: LibraryPlace,
  query: string,
): LibraryEntry[];
/** A place whose folder is gone falls back to All. */
export function settlePlace(place: LibraryPlace, folders: readonly LibraryFolder[]): LibraryPlace;
export function matches(e: LibraryEntry, q: string): boolean; // the current filter (name, customer, site), moved here
```

UI: under the header, when not searching and in All, a row of tiles (`data-testid="folder-tile"`, name and count, `role="button"`), plus **New folder** in `home-acts` (`data-testid="library-new-folder"`, a small name dialog). Click on a tile sets the place; in a folder the header shows `‹ All projects` (`data-testid="folder-back"`) and the folder name. Cards get `draggable` on `.pcard-wrap` with `e.dataTransfer.setData(DRAG_TYPE, entry.id)`; tiles and the back link take `dragover` (only when `types` includes `DRAG_TYPE`, `preventDefault`, a highlight class) and `drop` (`moveToFolder(entry, folderId)`; the back link moves to loose). Right-click on a tile: Rename folder, Delete folder (confirm with `library.folders.delete.text`). While searching, each card shows its folder name as a small chip. `MoveToFolderDialog`: a radio list of No folder plus every folder, the current one checked, Move button (`data-testid="move-folder-dialog"`). The header count stays the whole library. Show `libraryNotice` as a `notice` with Dismiss. An empty folder shows `library.folders.empty`.

- [ ] **Step 1: Failing tests** (`libraryFolderModel.test.ts`):

```ts
it('All shows loose cards only, a folder its own', ...);
it('a search finds cards in every folder', ...);
it('counts cards per folder', ...);
it('falls back to All when the open folder was deleted', ...);
it('treats a folderId with no folder as loose', ...);   // main sends only existing ids; the model stays safe
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/screens/libraryFolderModel.test.ts`: FAIL.
- [ ] **Step 3: Implement** (load `impeccable` / `frontend-design` first; keyboard: tiles focusable, Enter opens, the menu key or Shift+F10 opens the tile menu as cards do).
- [ ] **Step 4: Run** the tests, `src/renderer/screens` and `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `feat(desktop): one level of folders in the project library`

---

### Task 10: e2e remove and delete

**Files:**

- Modify: `apps/desktop/e2e/project-menu.spec.ts`
- Create: `apps/desktop/e2e/library-remove.spec.ts`

**Interfaces:** Consumes T4, T5 and the T3 menu test ids (`project-menu-remove`, `project-menu-delete`, `project-delete-confirm`).

- [ ] **Step 1: Write the specs.** `project-menu.spec.ts`: keep the open-project Delete hold; add "a job running greys Delete with A job is running in it" only if the spec can start a cheap fake job (else leave it to the unit test). `library-remove.spec.ts`, using the `start()` trash stand-in of `project-menu.spec.ts` (copy it):

```ts
test('remove hides a data-folder project; it stays hidden after a restart and Add project folder brings it back', ...);
// library-view.json lists the key; the folder still exists; addProjectFolder via a stubbed dialog:openFolder
test('delete moves a package and an added folder to the recycle bin after a confirm naming the path', ...);
test('a removed demo stays out after a restart, and Delete moves its working copy only', ...);
// needs the demo build (QUADRION_DEMO set by the fixtures when built); test.skip with a reason when absent
```

- [ ] **Step 2: Run** each spec the CI way (`--workers=1`, one run at a time): PASS. `--repeat-each=3` once on `library-remove.spec.ts`.
- [ ] **Step 3: Commit** `test(desktop): e2e for remove and delete on every card`

---

### Task 11: e2e folders

**Files:**

- Create: `apps/desktop/e2e/library-folders.spec.ts`

- [ ] **Step 1: Write the spec:**

```ts
test('make a folder, drag a card onto it, open it, go back, and the counts follow', ...);
// card.dragTo(folderTile) (Playwright fires HTML5 drag events in Chromium); tile shows "1 project"
test('Move to folder and No folder from the card menu', ...);
test('a search finds a card inside a folder', ...);
test('deleting a folder leaves its projects in the library and their folders on disk', ...);
test('folders survive a restart', ...);
```

Add one `expectAccessible(win, 'Project library with folders')` call as `project-menu.spec.ts` does.

- [ ] **Step 2: Run** it the CI way: PASS; `--repeat-each=3` once.
- [ ] **Step 3: Commit** `test(desktop): e2e for library folders`

---

### Task 12: Verify and hand off

- [ ] `pnpm check` green in the worktree.
- [ ] `pnpm demo:change --quick`, then the changed and new specs the CI way, one at a time: `project-menu`, `library-remove`, `library-covers`, `library-folders`, `builder`, `first-start`, `package`, `library`.
- [ ] `node tools/agent/check-public-text.mjs` on the spec, the plan and the session note; look at every screenshot taken.
- [ ] Independent review of the whole branch (strongest model, high effort), focused on `deletableTarget` and the Review Focus list.
- [ ] "How to test" for the founder in the closing message and the session note:
  1. Projects: right-click a received package, Remove from library: the card goes, a notice says Open package brings it back. Open package on it: it is back.
  2. Right-click a folder added from elsewhere, Delete: the confirm shows its full path; Delete: it is in the recycle bin.
  3. Right-click a demo, Remove from library; restart: it stays out.
  4. New project: on the first step pick a cover; finish: the card shows it.
  5. Right-click any card, Change thumbnail, upload a picture: the card changes at once. On a package, the dialog then offers the package's own picture back.
  6. New folder "Test", drag two cards onto it: the tile says 2 projects; click it, then All projects; type a name from inside the folder in the filter: it shows.
  7. Right-click the folder tile, Delete folder: the two cards are back in All, nothing on disk changed.
