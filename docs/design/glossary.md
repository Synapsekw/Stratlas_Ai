# UI glossary

| | |
|---|---|
| Status | **Decided** 2026-11-09 (UI revision W20), from the October UI review |
| Evidence | `docs/design/ui-review-2026-10/critique.md` (heuristic 2 and the persona notes), `code-audit.md` (naming) |
| Enforced by | `packages/ui/src/i18n/glossary.test.ts`: no string in the English catalogue uses a retired term |

The app speaks the user's language: surveying words (UTM, toe, chainage, PCI) and plain English. The October review found two problems. The AI had five names, and "cloud" meant both a point cloud and the network. It also found words the app made up and never explained: "Every date", "bench", "island", "File them / Not now", "EDL" and "Triangulated toe". This page sets one word for each thing. New copy uses these words, and the test fails when a retired one comes back into `packages/ui/src/i18n/en/`.

## Words to use

| Thing | Say | Notes |
|---|---|---|
| The AI, everywhere it is named (chat dock, photo questions, settings) | **Ask AI** | The only name for the feature. Its chat panel is "Ask AI chat" to screen readers. |
| The AI status chip | **AI ready**, **AI off**, **Offline AI** | Offline AI is a local model on this computer or network. Never "Cloud AI" in the status. The switch that sends every task to it is "Use Offline AI for everything". |
| AI that runs at an online provider | **cloud AI** | Always the two words together, never "cloud" alone. It pairs with Offline AI: "Allow cloud AI", "cloud AI off", "a cloud AI provider". |
| A point set from a scanner or photogrammetry | **point cloud** | Always both words: "point clouds hidden", "Box on the point cloud". A label too narrow for both words (a 72 px stage tools tile) says "3D" instead, "3D point" and "3D box", and its tooltip keeps the full words: a short label reads better than a clipped one. Never "cloud" alone. |
| The network | **online**, **offline**, **Offline only** | "Go online", "online maps". Never "in the cloud" for the network. |
| Datasets that belong to no survey date (they show with every date) | **No date** | The tree group and the move target. A prompt says "datasets with no date". |
| The prompt that files undated datasets under their survey days | **File by date**, **Leave for now** | Buttons say what they do. "Not now" stays fine as a plain dismiss on an offer. |
| The right panel's parts | **panel**, **tab**, **section** | The right panel holds tabs; the groups inside a tab are sections. |
| The bar at the top centre of the stage (modes, view and tools) | **stage tools** | Matches its accessible name, "Stage tools". |
| The point shading that brings out the shape of a point cloud | **depth shading** | The renderer calls it eye-dome lighting; the UI does not. |
| The volume base fitted through the pile's toe | **Toe surface** | The standard base. "Toe" is a surveying word and stays. |

## Retired terms

The test reads this table. Each row is a term no UI string may use; the test holds the matching pattern.

| Retired | Use instead | Why |
|---|---|---|
| `agent` | Ask AI | One AI name (founder, 30 Oct 2026). "Agent", "Ask agent", "Offline agent" and "the cloud agent" all became Ask AI or Offline AI. |
| `cloud` | point cloud, cloud AI, online | Bare "cloud" meant both a point cloud and the network. |
| `Every date` | No date | App-invented; it read as "all dates" when it means "not tied to one". |
| `File them` | File by date | The button did not say where the datasets go. |
| `bench` | panel, tab, section | Internal name for right-panel content. |
| `island` | stage tools | Internal name for the stage's top bar. |
| `EDL` | depth shading | An unexplained acronym. |
| `Triangulated toe` | Toe surface | Jargon; the plain words say what the base is. |

## Allowed exceptions

A retired word may appear where it means something else. The test keeps these in a commented allowlist, and each one needs a reason there:

- **"Privacy and cloud"**, the Settings page name: the page is about cloud AI and the network. About 30 hardcoded strings outside the catalogue and the user guide point to it by name, so it is renamed only when those move into the catalogue.

## Not covered yet

The test reads the English catalogue only. Some copy is still written inline in components and in the main process. Known leftovers: the task label "Agent chat" in Settings, AI providers (also "Provider for Agent chat"), the exported conversation title "Agent conversation", the annotation author "Agent", the annotate toolbar's own "Cloud point" and "Cloud box", and "Allow cloud AI" in Settings and package export (allowed wording, but inline). Those follow this glossary when they move into `packages/ui/src/i18n/en/`.
