# Exchange files and shared folders

A team project has a copy on each person's computer. Changes travel between the copies in one of three ways:

- **Exchange files**: you export changes to a file and send it on a USB stick or by email. Works across an air gap.
- **Shared folder**: a folder on a NAS or network share that every copy can reach. Each computer writes only its own files.
- **Team server**: your own server, run by your IT team (see [Team server (preview)](26-team-server.md)).

The project itself stays on each computer. Exchange files and shared folders need no network connection beyond the file share, and no account.

## Share a project

1. Open the project.
2. Click **Share** in the title bar. **Make this a team project** opens.
3. Check the **Team project name**.
4. Under **How changes travel**, pick **Exchange files**, **Shared folder** or **Team server**. Team server is greyed until a server is connected in **Settings**, **Data folder**, **Team server**.
5. For a shared folder, enter the **Path of the shared folder** or click **Choose folder**, for example `\\nas01\survey\hub`. Leave **Sync automatically every 15 minutes** ticked to sync on its own.
6. Click **Share**.

You become the project's first owner. The title bar now shows the sharing state instead of **Share**: **Exchange files**, **Synced just now**, **Not synced yet** or **Syncing**. Click it to open the **Team** dialog.

## The Team dialog

The **Team** dialog shows how changes travel, the **Last sync**, the **Changes not sent yet**, the **Conflicts** and, for a shared folder, whether it is **Reachable**. It has:

- **Sync now** (shared folder or server): "Synced: 1 received, 2 sent."
- **Export changes** and **Import exchange file**.
- **Use a shared folder** (exchange files only): switch the project to a shared folder or a team server.
- **Stop syncing this copy**: the data and its history stay; you can share again later.
- The **Conflicts** of the project (see [Conflicts](27-conflicts.md)) and its **Members** (see [Identity and team](21-identity-and-team.md)).

## Export changes

1. In the **Team** dialog, click **Export changes**.
2. Under **What to send**, pick **Changes only** (a small file, good for email) or **Changes and files** (adds the photos and other files the changes refer to).
3. Under **Which changes**, pick **All changes** or **Changes since a date**. The other copy skips what it already has, so **All changes** is always safe.
4. To protect the file, tick **Encrypt with a passphrase**, type it twice (at least 8 characters). Send the passphrase separately, never with the file. It cannot be recovered.
5. The dialog shows the size, for example "2 changes · 1 KB". Click **Export** and pick where to save. It says "Saved ...\Survey.aiosync".

Exchange files are limited to 2 GB. For more, send changes only and move the large files through a shared folder or a USB copy of the project.

## Import an exchange file

Double-click the `.aiosync` file, or click **Import exchange file** in the **Team** dialog and **Choose file**.

1. If the file is encrypted, enter its passphrase and click **Open**. A wrong one says "The passphrase does not open this exchange file."
2. Read the preview before anything changes:
   - **From**: the sender, such as "Rana Example (RE)", and "Signed by their device". "The signature does not match. Do not apply this file." means the file was changed after it was made.
   - **Changes** by kind, the number of new changes, what this copy already has, the expected conflicts and the files.
3. Click **Apply**. It says "Applied 2 changes."

Importing the same file again says "Already applied. Nothing in this file is new." and **Apply** is greyed.

If changes wait for earlier ones, the preview says "Some changes wait for earlier ones from ... (up to #12). Import those first." They are kept and applied once the missing ones arrive.

A damaged, cut short or tampered file is refused with a message that says why. Nothing is changed.

## Join a team project

Someone else shared the project. To join:

1. Get a copy of the project folder (a USB copy, or the same demo project) and open it.
2. Give the owner your identity card (see [Identity and team](21-identity-and-team.md#your-identity-card)). They add you as a member and export changes.
3. Import their exchange file. The preview says "Applying it makes this project part of the team project ...". Click **Apply**.

The title bar now shows **Exchange files**. To sync through the same shared folder, click **Use a shared folder** in the **Team** dialog, enter the same path and click **Share**.

With a shared folder you can also join without an exchange file: open your copy of the project, click **Share**, choose **Shared folder** and enter the folder's path. **Team project in this folder** lists the team projects the folder holds; pick the one to join instead of **A new team project**, then click **Share**. Your changes count for the others once the owner has added you as a member.

## Work with a shared folder

- {product} syncs when you click **Sync now**, and, with automatic sync on, every 15 minutes and when you come back to the window.
- If the folder cannot be reached, the title bar turns amber: **Folder offline**, "The shared folder cannot be reached. Your work is kept on this computer and syncs when it is back." The count of changes to send, such as "1 to send", stays until the next sync.
- The initials of people who have the project open show next to the sharing state.
- Each computer writes only its own files in the folder, and files once written never change. So two people never overwrite each other there.
- A OneDrive or Dropbox folder works as a shared folder. Files the cloud client keeps online only are slow to read the first time.

## A project opened by two people from a network drive

Two people can still open the same project folder on a share, as before. {product} checks before it saves: if the file changed since you opened it, your save is refused and nothing is overwritten. The app says "issues.json was changed by someone else since you opened it. Reload to see their changes; your edit was not saved."

Click **Reload** to see their changes, then make your edit again. **Dismiss** closes the notice.

For team work, a copy on each computer with a shared folder is better: both people's changes are kept.

## Two people on one computer

To try all this alone, start a second profile (see [Identity and team](21-identity-and-team.md#two-people-on-one-computer)), give it a copy of the project folder, and use a folder on this computer as the shared folder.
