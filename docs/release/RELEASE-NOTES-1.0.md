# Stratlas 1.0 release notes (draft)

Draft of 7 Oct 2026. The final pass, with the product name, dates and screenshots, comes with release candidate 1. Items marked _(preview)_ ship as a preview.

## Highlights

- **Work as a team, or alone as before.** Share a project with your team through a shared folder, by USB with transfer files, or through a Team Server on your own premises _(preview)_. Working alone, offline and without an account works exactly as in 0.8.
- **Assign, discuss and approve findings.** Assign an issue or a change to a reviewer, comment on it, and approve it or ask for changes. One approval by a second person is the default; editing the class, severity, sightings, measurements or status of an approved issue asks for approval again.
- **A history you can prove.** Every change to issues, change reviews, detections, boundaries, models and report text is kept in the project's history with who made it, when and on which computer, signed and chained. **Verify** names any change that was edited, removed or reordered later. Customer packages carry a signed summary of the history, and the full history when you tick it.
- **Conflicts never lose work.** When two people change the same thing, the latest change wins and the other one waits in **Conflicts** with **Restore**.
- **Large projects by content.** Big files are fetched when you open them, so a team member can join a large project with the issues and reports first.

## Also new

- My work: what is assigned to you, waiting for your approval, or commented on.
- Audit exports (CSV and JSON) and audit and sign-off sections in the house report.
- Identity cards (`.aioid`) to introduce a team member's computer to a project owner.
- Clients can reply to a package with comments and acceptance in the free player, as a separate signed file.

## Upgrading

- Projects from every earlier version open in 1.0 with nothing lost; a `.bak` appears only for files you change.
- A project edited in 1.0 still opens in 0.8. Its team data is ignored there, and edits made in 0.8 show in 1.0's History as "changed outside Stratlas".
- If a file was saved by a newer Stratlas, 1.0 says so and leaves the file alone: update the app to open it.
- Settings carry over. If you go back to 0.8, your house report choices are kept; the new audit and sign-off sections return to their default when you come back to 1.0.
- The pipeline pack 1.0.0 works with Stratlas 0.9 to 1.x and says so if it is paired with another version.
- See [UPGRADE-POLICY.md](UPGRADE-POLICY.md) for the full policy.

## Privacy and security

Nothing is sent to Synapse Solutions. Sharing uses your own shared folder, transfer files or your own server, and signing keys stay in the computer's credential store. Details for IT and procurement: [SECURITY-AND-DATA.md](SECURITY-AND-DATA.md).

## Support

1.0.x receives patches for 12 months. See [SUPPORT.md](SUPPORT.md).

## Known limits

- Roles are recorded but not enforced when sharing through a shared folder or transfer files; a Team Server enforces them.
- No real-time co-editing and no email notifications.
- The interface is in English. Arabic text works in comments, names and reports, with right-to-left panels; a full Arabic interface follows after 1.0.
- Notes saved in the legacy viewers are not part of the history.
- The Team Server is a preview until its external security test has passed.
