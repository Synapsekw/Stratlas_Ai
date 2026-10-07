# Conflicts

When two people change the same thing while apart, both changes arrive at the next sync. {product} merges them field by field and never throws a value away silently. Where both changed the same field to different values, it keeps the later change and asks you to decide.

## How changes merge

- Different fields of one issue: both changes are kept. Rana changes the severity, Omar the title: the issue has both.
- The same field: the change made later wins for now, and a **conflict** lists both values. The other value stays in the history.
- Sightings: both people's new sightings are kept.
- New issues made on both copies: both are kept. If they got the same code, the later one moves to the next free code and you get a notice, for example "F10 was F09. Another issue made apart has that code, so it is now F10." Click **OK**.
- An issue deleted on one copy while it was changed on the other: it is kept, and the conflict offers **Delete again**.

Any two copies with the same changes show exactly the same issues, whatever order the changes arrived in.

## Where conflicts show

- The title bar shows the count, for example "1 conflict", and the **Team** dialog says "1 change needs a decision: both copies changed the same field."
- The **Conflicts** list is in the **Team** dialog. **My work** in **Issues** lists them under **Conflicts** too.

With no conflicts the list says "No conflicts. Changes from others merged cleanly."

## Decide a conflict

Each conflict is headed by the record and field, such as "F02 severity". It shows both values with who made each and when: "3, You" and "4, Omar Sample". The value in the project now is marked **In the project now**.

- **Keep mine** or **Keep theirs**: that value stays (or comes back).
- **Edit**: type a new value and click **Save**.
- **Earlier values**: the field's past values; **Restore** puts one back.
- For a deleted issue: **Delete again** or **Keep it**. For a merged issue: **Merge again** or **Keep it**.

Your decision is a change of its own. It reaches the other copies at the next sync, and the conflict goes away there too. History shows every value, for example 2, 3, 4, then 3 again.

## Quarantined changes

A change that came from another copy but should not apply is kept and listed under **Quarantined changes**, for example:

- a change beyond its author's role, such as a reviewer changing the coordinate system: "Omar Sample is a reviewer in this project. Only an owner can change the coordinate system, origin or datum.";
- a change from someone who is not a member, or from a revoked device;
- a change that was altered after it was made, or whose signature does not match;
- a change from a computer whose clock was more than a day ahead. {product} also notes when a computer's clock is more than 5 minutes ahead.

Each entry reads, for example, "Status changed on F04 by Omar Sample, ...". Quarantined changes are kept but not applied. An owner can click **Apply anyway**; the decision is recorded. Others see "Only an owner can apply these."

In exchange-file and shared-folder mode this protects the team's history, but anyone who can write to the folder can still edit its files. Such edits show as "Changed outside {product}" in History. A team server refuses these changes before they reach anyone.

## Avoid conflicts

- Sync often: with a shared folder, leave automatic sync on.
- Assign issues (see [Review workflow](23-review-workflow.md)) so two people do not edit the same one.
- Changes to different fields never conflict.
