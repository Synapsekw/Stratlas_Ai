# Review workflow

In a shared project the team assigns findings, discusses them and approves them. Every step is signed and kept in the history (see [History and audit](22-history-and-audit.md)).

A project that is not shared works as before: you move an issue's status with the status buttons. Approvals start once the project is shared (see [Identity and team](21-identity-and-team.md)).

## The review area of an issue

Pick an issue and open **Edit issue** at the bottom of its card. The **Review** area holds:

- **Assign**: who works on it, and by when;
- **Comments**: the discussion;
- **Approvals**: who approved it, and what is still needed.

## Assign an issue

1. Click **Assign**.
2. Pick the **Person** and, if you like, a **Due date**. Click **Save**.

The area reads "Assigned to Omar Sample" and "Due Fri 9 Oct". **Unassign** clears it.

## Comment

1. Open the **Comments** tab.
2. Write in **Write a comment**. Type **@** and pick a name to mention someone.
3. Pick **Who can see it**: **Team only**, or **Client can see it**.
4. To point at something, click **Attach view**: the comment keeps the 3D camera, the time and the layer shown.
5. Click **Comment**.

On a comment with a view, **Go to the view** flies the camera there. **Reply** answers it. You can **Edit** or **Delete** your own comments; an edited comment shows "edited". Links in comments are shown as text and never opened. Arabic and right-to-left text work.

## Approve

With a team project, an issue becomes **Approved** through approvals, not through the status button.

1. Mark the issue reviewed first (**Mark reviewed** in **Edit issue**).
2. Open the **Approvals** tab and click **Approve**.

The tab says how many approvals are needed, for example "Needs 1 approval", "not by the person who made or last changed it". That is the four-eyes rule:

- If you made the issue or last changed it, **Approve** says "Another reviewer must approve this. You made it or last changed it."
- When another reviewer approves, it says "Approved. The status is now Approved."
- If more approvals are needed: "Your approval is recorded. More approvals are needed."

**Request changes** asks for a change; it needs a comment in **What needs to change?**, then **Send request**. **Withdraw** takes your own approval back.

### When an approved issue changes

A change to the class, the severity, the sightings, the measurements or the status makes the approval out of date. The issue goes back to **Reviewed** and the approval shows **Approval out of date**. A change to the title or the note does not.

Only an owner closes or reopens an approved issue, unless the project allows reviewers to.

## My work

In **Issues**, click **My work**. The count shows how many items wait for you. It lists:

- **Assigned to me**;
- **Mentions**: comments that mention you;
- **Awaiting my approval**;
- **Conflicts** and **Quarantined**: changes that need a decision (see [Conflicts](27-conflicts.md)).

Click an item to open it. A mention with a view flies the camera there.

**Mine** in the register shows only the issues assigned to you or mentioning you.

## Changes between dates

In the **Changes** panel (see [Changes between two dates](14-changes.md)), a change item has **Comments** and **Assign** too. The **Sign-off** tab has **Sign off change register** once the items are reviewed.

## Sign off the report

On **Reports**, the **Sign-off** card shows **Prepared by**, **Reviewed by** and **Approved by**, with names, initials and dates, and "3 of 5 findings approved". **Sign off report** records your sign-off of the report's contents. If a finding changes afterwards, the card says "Report approval out of date: a finding changed after it was signed."

The house report can print a **Sign-off and approvals** section with the same block.

## The assistant

The assistant can help with the review, but it never approves.

- "What is assigned to Omar?" lists the work.
- It can show a thread, write a comment (you approve the comment first) and ask a reviewer for approval: it assigns the issue and mentions them.
- "Approve F03" gets the answer that only a person approves.

## Client comments and acceptance

A comment marked **Client can see it** shows a **Client** tag. A client's acceptance is recorded as "accepted for the client"; it never changes the status by itself.
