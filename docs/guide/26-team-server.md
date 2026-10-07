# Team server (preview)

A team server shares projects through a server your IT team runs on your premises. It checks each person's role on every change and refuses what the role does not allow. Nothing goes to Synapse.

The team server is a **preview** in this version. Exchange files and shared folders need no server at all (see [Exchange files and shared folders](24-exchange-files-and-shared-folders.md)). Alone or offline, you need no server.

Your IT team installs the server with the admin guide that comes with it. They give you its address, an invite code and the server certificate's fingerprint.

## Connect to the server

1. Click **Settings**, **Data folder**. Scroll to **Team server** (**Preview**). With no server it says "No team server is connected on this computer."
2. Under **Connect to a team server**, enter the **Server address** (it starts with `https://`, for example `https://team.example.com:8443`) and the **Invite code**.
3. Click **Connect**. {product} contacts the server.
4. **Check the certificate**: compare the **Certificate fingerprint**, group by group, with the one your IT team gave you. Connect only if every group matches.
5. Click **They match, connect**. It says "Connected to Survey team."

The server shows in **Team servers on this computer**, with a green dot and "Enrolled as reviewer, server version 0.1.0".

Each invite code works once and for a few days. A code already used, mistyped or expired says "This invite code is not valid. It may be mistyped, used or expired."

**Forget** removes the server from this computer. Your projects stay as they are.

## When {product} talks to the server

Only when you connect, and when a project in server mode syncs. With **Offline only** on (in **Privacy and cloud**), the page says "Offline only is on, so this computer makes no network connections." and **Connect** is greyed.

Every request is signed with this computer's device key (see [Identity and team](21-identity-and-team.md)). There is no password to type or steal. The server's certificate is remembered at the first contact: a server with another certificate is refused.

## Share a project through the server

1. Open the project and click **Share** in the title bar.
2. Pick **Team server**, and the server if there are several. Click **Share**.

The first sync runs at once. After that, **Sync now** in the **Team** dialog, or automatic sync, sends and receives changes.

Other people join the same way as with exchange files: they import one exchange file of the project, then click **Use a shared folder** in the **Team** dialog, pick **Team server** and click **Share**.

## If the server is not there

When the server cannot be reached, you keep working. Your changes wait on this computer and go at the next sync.

## Roles on the server

The server refuses a change the person's role does not allow, for example an edit by a viewer. Owners manage members in the app as usual (see [Identity and team](21-identity-and-team.md)). People who joined through the server show the **Server-enrolled** badge.

## What the preview does not do yet

- No web page: the IT team manages the server from its command line.
- Clients cannot fetch packages from the server yet.
- The app shows no live server status.
