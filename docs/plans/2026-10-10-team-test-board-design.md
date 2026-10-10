# Team test board: design

Date: 10 Oct 2026. Status: built. The founder uses it online; the team gets it as a file.

## Goal

A small team tests every feature of Quadrion AI in a fixed order and records a result for each line. The founder sees every tester's results next to each other. `docs/TESTING.md` stays the only testing document: the board is built from it and never edited by hand.

## What the founder decided (10 Oct 2026)

- Testers use a **guided run**: one test line at a time, in order, with **Works**, **Does not work**, **Skip** and a comment.
- The founder reads an **overview**: every line with one column per tester, side by side.
- The founder is a tester too.
- The run is grouped **by vertical** (a customer use case and its projects), not by milestone.
- The page opens on the app's **launch screen** and then asks who is testing. The logo returns to it.
- The page follows the product's Mission design direction (`docs/design/DIRECTION.md`).
- The team gets the board as **one HTML file**, works in it, and emails a results file back.

## Nothing private in the repository

The repository is public. The tool in `tools/test-board` therefore carries no client, site or tester name. Everything of that kind lives in a **private folder** outside the repository, which the build reads:

| In the private folder | What it holds                                                                           |
| --------------------- | --------------------------------------------------------------------------------------- |
| `config.json`         | Who tests, who gets the results, the verticals, and the rules that place each line      |
| `setup.md`            | The first vertical: what a tester does once (install, data folder, adding the projects) |
| `extra.md`            | Drafted test lines that `docs/TESTING.md` does not have yet                             |

```
node tools/test-board/build.mjs --private "<private folder>"
```

Without `--private` the build uses `QUADRION_TEST_BOARD_PRIVATE`, then `tools/test-board/local` (git-ignored) when it exists, and otherwise the tool's own defaults: milestone stages and two placeholder testers. The private `config.json` overrides `tools/test-board/config.json` key by key. The output in `tools/test-board/dist` is git-ignored, because it holds the names.

## How it works

**Build.** `tools/test-board/build.mjs` reads `docs/TESTING.md` with the existing parser (`tools/review-board/parse.mjs`), leaves out stages that cannot be tested yet, and writes one self-contained page with the test lines embedded as data. It writes the page twice: `test-board.html` for publishing as a claude.ai Artifact, and `Quadrion-Test-Run.html`, a whole document for opening from a PC.

**Item ids.** The parser's ids are kept: a hash of the stage and the line's text. An answer survives reordering and regrouping. A reworded line counts as a new, untested line, which is the right outcome after a fix changes behaviour.

**Verticals.** With `verticals` configured, each line goes to the vertical of the first rule that fits it. A rule names a stage and a group by the start of their titles, and a line by a pattern on its text. Each group keeps its milestone in its title ("M6 · P1 Inspection from raw data") and the milestone's introduction in its notes.

**Guided run.** Shows the vertical, the group and its notes, then one line with the three buttons (keys 1, 2, 3) and a comment box. A track above the line shows every line of the vertical in its result colour, with a playhead on the current one. A comment is required for **Does not work**. **Works** and **Skip** move on by themselves, and the run reopens at the line the tester left.

**Overview.** A run matrix at the top: one track per tester over all lines, vertical by vertical, so clusters of failures show at a glance. Below it one row per line with one column per tester. Filters: all, not tested, failed, disagreements, commented.

**Testers.** Named slots from the config, not accounts: a viewer picks who they are once and the browser remembers it. Anyone who can write can write any slot, which is accepted for a few trusted people and lets the founder take in results a tester sent.

## Where answers are kept

| How the board is opened                         | Answers                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| The Artifact, by its owner or an invited editor | Autosaved online, one document per tester and line (`results/<tester>/items/<line id>`) |
| The Artifact, by anyone else                    | In that browser only, with **Copy my results**                                          |
| The HTML file                                   | Autosaved in that browser, and written to a results file                                |

**Results file.** **Save results file** writes a small JSON file. In Chrome and Edge the tester chooses it once and it then updates itself after every answer; other browsers download a new file each time. **Load results file** takes such files in: in a saved copy to carry on elsewhere, and in the Artifact to fill a tester's column and store the answers online. The later answer of a line wins, so an older file never undoes newer work.

A public link to the Artifact is read-only for other people and shows the page to anyone who has the link, so the file is the way to share.

## Testing

- Unit tests for the build (`tools/test-board/build.test.mjs`): every line of an included stage appears once, excluded stages are absent, stage order follows the config, ids are stable, lines are placed by the first fitting rule, a regrouping keeps the ids, and the real testing document builds.
- Checked by hand in a local run: the launch screen and the tester pick, answers and the required comment, the overview filters, the results file (written, updated by itself, loaded), taking results files into the online store against a stand-in, phone width, light and dark.
- Not checked: the real file dialog of Chrome and Edge, and a second person's file loaded into the live Artifact.

## Out of scope

- Screenshot upload, assigning lines to one tester, sign-off or locking a vertical.
- Changes to the local review board (`tools/review-board`), which stays as the founder's own tool.
