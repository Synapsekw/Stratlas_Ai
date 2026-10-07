# Identity and team

{product} records who made each change. Your name and initials appear on issues, reviews and the project history. When you share a project, the people on it are its **members**, each with a role.

You need no account and no network. A person working alone keeps working exactly as before.

## Your name and initials

1. Click **Settings**, then **Identity and team**.
2. Under **Your identity**, check **Your name**. The first time, it is the name you used before, or your Windows account name.
3. Check **Initials**. They are made from the first letters of your first and last names. You can change them: 1 to 3 letters, then one digit if you like ("DR", "DR2"). Arabic letters work.
4. **Email (optional)** is only shown to your team.

Issue chips and the issue register show initials. Point at them to see the full name.

If the initials are not valid, the page says "Initials are 1 to 3 letters, optionally followed by one digit."

## This computer's device key

Under **This computer** you see "Device key d_..., kept in the credential store." The key signs every change you make on this computer, so nobody can later change your entries without it showing.

- The private key stays in the Windows Credential Manager (on a Mac, the Keychain). It never goes into a project, a file you send, a log or a diagnostics bundle.
- The key is made the first time it is needed. Until then the page says "No device key yet."
- If the credential store cannot be used, the page says "The credential store is not available, so your changes are recorded without a signature." Your work is kept; **Verify** reports those entries as not signed.

## Your identity card

To join someone's project, send them your identity card:

1. In **Settings**, **Identity and team**, click **Export identity card**.
2. Pick where to save it. The page says "Saved to ...\Omar Sample.aioid".
3. Give the file to the project owner, by USB or email.

The card holds your name, initials, email and your device's public key. It holds no secret.

## Share a project and add members

A project becomes a team project when you share it. The person who shares it is its first **owner**.

1. Open the project.
2. Click **Share** in the title bar and pick how changes travel (see [Exchange files and shared folders](24-exchange-files-and-shared-folders.md)). Click **Share**.
3. In the **Team** dialog, or in **Settings**, **Identity and team**, find **Members of** the project.
4. Click **Add from card** and pick the person's `.aioid` file.
5. Pick a role in **Add as**.
6. Tick **Certify this card (you checked it with the person)** if you did, in person or on a call. Click **Add** with the person's name, for example **Add Omar Sample**.

In a project that is not shared yet, the page says "This project is not shared. Add a person from their identity card to share it: you become its owner." You still choose how changes travel with **Share**.

The members table shows each **Person**, their **Role**, their **Identity** and their **Devices**. You show as "(you)".

The **Identity** badge says how sure the team is about who the person is:

- **Unverified**: the person typed their name; no owner has checked it.
- **Certified by you** or **Owner-certified**: an owner checked the card.
- **Server-enrolled**: the person joined through a team server.

## Roles

| Role         | What they can do                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| **Owner**    | Everything, including members, roles, devices, the review policy and the coordinate system           |
| **Reviewer** | Edit issues and reviews, comment, assign, approve, change layers; not the coordinate system or datum |
| **Viewer**   | Read, verify and export the audit; comment only when the project allows it                           |
| **Client**   | Comments the client may see, and acceptance                                                          |

A project that is not shared has no roles.

When a change from another copy goes beyond its author's role, {product} keeps it but does not apply it. It shows under **Quarantined changes** (see [Conflicts](27-conflicts.md)).

## Change a role, remove a member, revoke a device

Only an owner can do these. Each one is recorded in the history.

- **Role**: pick another role in the member's row. You cannot change your own role.
- **Remove**, then **Confirm remove**: the person's later changes are no longer accepted. The last owner cannot be removed.
- **Revoke device**, then **Confirm revoke**: use it when a computer is lost or replaced. The device shows **Revoked**. Changes made on it before the revocation stay valid; later ones are held back. Add the person's new device from their new card.

## Two people on one computer

For training or testing, one computer can act as two reviewers. Each one has its own settings, library and device key.

1. Make a copy of the {product} shortcut on the desktop.
2. Right-click the copy, **Properties**. At the end of **Target**, after the closing quote, add a space and `--profile=reviewer-b`. Click **OK**.
3. Start the copy. It opens as a new person: set the name, for example "Omar Sample", in **Settings**, **Identity and team**.

From a Command Prompt in the install folder, the same is:

```
{product}.exe --profile=reviewer-b
```

Both windows can be open at once. Give the second person their own copy of the project folder, and share it between the two as described in [Exchange files and shared folders](24-exchange-files-and-shared-folders.md). In the Credential Manager each profile has its own entry.
