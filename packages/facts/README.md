# @aio/facts

The project fact index (intelligence review Wave 3, M1; study `insight.md` 5.6 and 5.7): typed facts about one project and the links between them, kept in SQLite with FTS5. It is **derived, never a source of truth**. It is built from the project's files and journal, and deleting it and building again gives the same rows. Main keeps one index file per folder project in `userData/fact-index/`, never in the project folder (`apps/desktop/src/main/facts.ts`).

The binding is `node:sqlite`, which is built into Node 24 and Electron 44, with FTS5 and the porter tokenizer. Nothing native ships. The package depends on `@aio/schema` and `@aio/journal` only.

## Pieces

- `readProjectSources(root)` (`sources.ts`) reads a folder tolerantly: a missing or unreadable file, or an unreadable record, is left out. It reads `manifest.json`, `survey/measurements.json`, `survey/qa/*.json`, `photogrammetry/*/report/accuracy.json`, `detections/*.json`, `issues.json`, `change/*.json`, `thermal/thermal.json`, `thermal/candidates.json`, `walks/*/walk.json`, `telecom/history/*.json` (the antennas each survey date measured), `ai/memory.json` (the agent's project notes, A3; a bad note is left out), and the journal as audit entries.
- `extractFacts(sources)` (`extract.ts`) is pure and deterministic. It returns `{ facts, links }`, both sorted.
- `openFactIndex(file)` (`store.ts`) opens or creates an index. Pass `':memory:'` in tests. An index of another `FACT_INDEX_VERSION` is dropped and made again. A file that is not a database throws, and the caller deletes it and opens again.

The shapes (`Fact`, `FactLink`, `FactQuery`, `FactHistory`, `FactIndexStatus`) live in `@aio/schema` `facts.ts`, because they cross IPC.

## The query API (for the agent, A3 memory and X1 MCP)

```ts
const ix = openFactIndex(file);
ix.sync(extractFacts(await readProjectSources(root))); // build or update: only changed rows
ix.query({ text: 'north stockpile', kinds: ['volume'], from: '2026-07-01', limit: 20 });
ix.historyOf('measurement:pile-north'); // { subject, facts, linked: [{ rel, fact }], events }
ix.linksOf('issue:i1'); // both directions
ix.status(); // { state, builtAt, counts per kind, links }
ix.dump(); // every fact and link, sorted: equal for equal sources
ix.close();
```

- **`query(q)`**: every field narrows the result.
  - `text`: FTS5 over the label (weight 4) and the text (weight 1). Each word must match as a prefix, and the porter stemmer is used. `ftsQuery` turns free words into a safe match expression, so a quote or operator in the input cannot break the query.
  - `kinds`, `subject`, `capture`, `status`.
  - `from` and `to`: ISO dates, compared with the fact's day. The day is its survey date, or else the day it happened.
  - `near`: `{ e, n, radiusM }` in the project CRS.
  - `limit`: default 50, at most 500.
  - Ordering: with text, the best match comes first. Without text, the newest comes first. `total` counts every match.
- **`historyOf(subject, limit?)`** returns three lists. Each holds the newest `limit` entries (default 200, at most 500), shown oldest first:
  - `facts`: the subject's own facts, events left out (a measurement and its volume on each date).
  - `linked`: the facts of every linked subject, with the relation. One limit covers all linked subjects together, newest first by day, so a date's issues and volumes are not crowded out by hundreds of detections.
  - `events`: the journal ops on the subject.
  - `totals` counts every entry of each list, so a reader can say how many older ones were left out.
- **`sync(next)`** runs in one transaction. It inserts, updates (by row hash) and deletes facts, and adds and removes links, so an updated index always equals a fresh build.
- **Limits:** every string stays within the `Fact` limits (label 400, text 4000, ...). Text is cut with an ellipsis. Ids and subjects are cut with a hash of the whole name, so two long names stay apart and links still meet their facts.

## Files and the worker (`folder.ts`)

- `syncFolder(root, file, { fresh? })` reads, extracts and writes one index file. It returns the counts and the time of each phase. A damaged file is deleted and made again, and the folder is recorded in the index (`root()`).
- `pruneIndexes(dir)` deletes the index files whose folder is gone, together with their `-wal` and `-shm` files.
- Main runs both in a worker thread (`apps/desktop/src/main/factsWorker.ts`) and keeps only a read connection per project. If the worker cannot start, it builds in process.
- **Measured (11 Nov 2026, this computer):**
  - Synthetic 20,000 detections (20,016 facts, 60,026 links): extract 110 ms, first write 1.7 s, an unchanged update 185 ms.
  - The built demos (27 to 52 facts): under 60 ms each in all.

### Subjects

A subject names the thing a fact is about as `<record kind>:<id>`. Where the journal has a record kind, the journal's kinds are used, so an op's `target` maps to its subject (`subjectOfTarget`). The subjects are:

- `survey:<capture>`, `layer:<id>`, `photo:<layer>/<photo>`;
- `measurement:<id>` (its `volume` facts share it, one per date and item);
- `detection:<id>`, or `detection:<pass file>#<n>` when the detection has no id;
- `issue:<id>`, `qa:<capture>`, `accuracy:<run>`;
- `change-set:<id>`, `change-item:<set>/<item>`;
- `hotspot:<id>` and `hotspot:candidate/<n>`;
- `walk:<id>`;
- `antenna:<id>` (its `antenna` facts share it, one per survey date that measured it, from `telecom/history/<capture>.json`);
- `note:<id>`: a note the person keeps about the project for the agent (`ai/memory.json`).

### Kinds and links

- **Kinds** (`FACT_KINDS`): `survey`, `layer`, `photo`, `measurement`, `volume`, `detection`, `issue`, `qa`, `accuracy`, `change-set`, `change`, `hotspot`, `walk`, `antenna`, `event`, `note` (since `FACT_INDEX_VERSION` 2).
- **Positions:** `e` and `n` are project CRS easting and northing. Photo positions convert from the local frame (X east, Z south) with the manifest origin. Detections, issues on photos and hot spots take their photo's position.
- **Links** (`FACT_RELATIONS`), made at index time:
  - `on-photo`, `on-survey`, `in-layer`;
  - `issue`: a detection or hot spot that became an issue, and the next issue of the same track;
  - `in-set`: a change item to its set, and a set to its two dates;
  - `about`: a change item to its issue or detections, and a note to the subject it is about (so it shows in that subject's `historyOf`);
  - `qa`: a measurement to the QA of each date it has a volume on;
  - `inside`: a detection, issue, hot spot or change item inside a polygon measurement's outline on the same date ("an issue on a pile").

## Tests

- `facts.test.ts` runs on the fixture project of `testing.ts` (`@aio/facts/testing`: one record of every kind, plus the signed journal fixture of `@aio/schema`). It checks reading, extraction per kind, the links, determinism, rebuild equality, the incremental diff, search, the filters, history order, the version reset and a damaged file.
- `scale.test.ts` covers history cuts at size (300 detections on a date, 300 journal ops), long names, folder sync and prune, and the 20,000-detection build time. Set `QUADRION_FACTS_BENCH` (folders separated by `;`) to time real folders.
- The main service and the worker runner have their own test (`apps/desktop/src/main/facts.test.ts`).
