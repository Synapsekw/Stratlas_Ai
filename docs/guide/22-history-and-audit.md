# History and audit

Every change to a project is recorded: who made it, when, and how. The record is signed and chained, so a later edit, a removed line or a copied folder that kept writing shows up when you check it. Nothing is ever deleted from it.

This works for every project on this computer, shared or not, with no network.

## History of an issue

1. Pick an issue and open **Edit issue** at the bottom of its card.
2. Scroll to **History**: the changes to this issue, newest first.

Each entry shows:

- who made it and when;
- how: **By hand**, **By the assistant**, a pipeline run such as "Inspection pipeline (run by Rana Example)", **Changed outside {product}**, **Imported** or **From the team server**;
- the label of the edit, such as "F01 to reviewed";
- the values before and after, such as "severity 1 to 3".

The history stays when you close the project or restart {product}.

### Restore earlier values

Click **Restore** on an entry to put those values back. It reads, for example, "Restore F01 severity". The restore is a new change: the history keeps everything that came before.

## Changes made outside {product}

If someone edits a project file with another program, or an older version of {product} saves it, the next open records the difference. History shows it as **Changed outside {product}**, with no name, because the app cannot know who did it.

## The audit trail

The audit trail lists every change to the project.

- Open it from **Reports**, **Open audit trail**, or from the project menu at the top of the sidebar, **Audit trail**.
- Use the **Filters**: **Who**, **What**, **Record** (an issue code such as F01), **From**, **To** and **How**. **Clear filters** shows everything again.
- **Load more** shows older entries.

Entries can carry a state: **Not signed**, **Signature does not match**, **Held back** (the author had no permission for this change when it was made) or **From a newer version**.

## Verify

Click **Verify** on the audit trail. It checks every entry, every link between entries and every signature.

- "The history is intact. Every entry is signed." All is well.
- "The history is intact. 3 entries are not signed." Some changes were made when the credential store could not be used.
- "1 problem found." The report names the file and line, for example "Line 1 of journal/ops/.../000001.jsonl was edited."

The project still opens and works whatever Verify finds.

Verify also finds removed lines, lines out of order, a whole file of entries removed, a signature that does not match, and a twin from a copied folder that kept writing.

## Export the audit

- **Export audit (CSV)**: a table that opens in Excel. Names and Arabic text stay intact.
- **Export audit (JSON)**: the entries, the Verify report and the whole signed history. Anyone can check it without {product}:

```
node tools\audit-verify\verify.mjs <the exported file>
```

It prints "Intact" and the audit head.

## The audit head in reports

Every report {product} makes prints the audit head in its footer: "Audit head 3f9a1c..., 412 entries, verified". It identifies the history at the time of the report. A later change to the history gives a different head, so a report already delivered would no longer match.

The house report can also include an **Audit trail** section: the head and the changes per issue.

## Redact an entry

You can remove the details of an entry, for example personal data written in a note by mistake. In a shared project only an owner can; others see "Only an owner of this team project can redact its history."

1. Click **Redact** on the entry in the audit trail.
2. Give a reason if you like, then **Redact entry**.

The details are removed from every copy at the next sync. The entry stays, and reads "Redacted by Rana Example on ...", so the history still verifies. This cannot be undone.

## Is the history always on?

Yes. The history is on for every project on this computer, and a team project always keeps it. Packages opened in the player are read-only: their history is never added to.
