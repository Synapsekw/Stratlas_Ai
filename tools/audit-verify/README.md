# Audit verify

`verify.mjs` checks a Quadrion AI project's audit trail (its journal) without the app. It is one file
that uses only Node's own modules, so you can read every line of it before you run it.

## What you need

Node 20 or later. Nothing to install.

## How to run it

```
node verify.mjs <project folder | audit .json> [--json] [--now <iso time>]
```

- A **project folder** is the folder that holds `manifest.json` and `journal/`. Every file under
  `journal/` is read.
- An **audit JSON export** is the JSON audit export Quadrion AI writes (`audit-json`). It carries every
  journal file, every device's public key and the checkpoints.
- `--json` prints the full report instead of the summary.
- `--now` sets the time the check treats as now, for entries whose clock was ahead. The default is
  this computer's time.

Examples:

```
node verify.mjs "D:\Projects\Tank farm"
node verify.mjs tank-farm-audit.json --json > report.json
```

## What it checks

The same things as Verify in the app, with the same problem codes, files and lines:

- every entry still hashes to its id, and its content to its content hash;
- every entry is signed by the device that wrote it, and every device record is signed by its own
  key;
- each chain runs 1, 2, 3 and so on with no gaps, no reordering and no second copy (a fork);
- no segment file is missing and no chain's end was cut off;
- checkpoints still match the entries they signed;
- content was removed only where a redaction names it;
- nothing was written by a device after it was revoked.

When the journal is intact it prints a line such as:

```
Intact: 16 entries in 3 chains, all signed. Audit head 99213e81...
```

The audit head is a SHA-256 Merkle root over the last entry of every chain. It is the value printed
in the footer of Quadrion AI reports, so you can match a report to the journal it came from.

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | Intact                                        |
| 1    | Problems found (each one is listed)           |
| 2    | The input could not be read, or a wrong usage |
