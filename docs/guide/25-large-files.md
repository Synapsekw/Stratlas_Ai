# Large files

Point clouds, models and video can be many gigabytes. In a team project they do not have to be on every computer before the project opens. {product} knows each file by its content (a SHA-256 fingerprint), so it can fetch it later, check it on arrival, and store a file used by several layers only once.

A project that is never shared works as before: its files stay where they are, and nothing is moved, renamed or hashed unless you ask.

## A layer that is not on this computer

When you open a team project whose large files are on the shared folder or the team server, the project opens at once. A card in the scene says, for example, "1 layer is not on this computer".

Click **Files** on the card. **Files on this computer** lists each layer with its state:

- **On this computer**.
- **Not on this computer (12.4 GB)**, with **Download**.
- **Downloading 3.1 GB of 12.4 GB**, with **Cancel**.
- **Paused at 3.1 GB of 12.4 GB**, with **Resume**: the download goes on from where it stopped.
- **Streaming from the shared folder**: the layer is read from the share, not copied.
- **Changed since it was shared**: the copy on this computer no longer matches. **Download** fetches a clean copy.

The layer appears in the scene as soon as its files are here. The rest of the project works meanwhile.

## When files are fetched

For each layer, **Get files** sets when this computer fetches its files:

| Choice                        | What happens                                               |
| ----------------------------- | ---------------------------------------------------------- |
| **Always**                    | Fetched when the project opens and at every sync           |
| **When the project opens**    | Fetched when you open the project                          |
| **Only when I download**      | Fetched only when you click **Download**                   |
| **Stream from shared folder** | Read from the shared folder over the network, never copied |

The defaults: files over 200 MB, such as video, point clouds and large models, wait for **Download**. Maps, rasters and vectors are always fetched. Photos are fetched when the project opens.

**Stream from shared folder** suits video on a fast local network: it plays without filling your disk.

The choice is per computer: a laptop on site can keep video on the share while an office PC copies it.

## Where downloaded files go

Downloaded files live in {product}'s own folder on this computer, not in the project folder. **Download cache** shows how much it holds, for example "Download cache: 14 GB of 50 GB".

- Each download is checked against its fingerprint. A file that does not match is moved aside and fetched again.
- Nothing is deleted on its own. When space is freed, only files that the shared folder or the server also holds can go, and never a file an open project uses.

## Files in exchange files

**Export changes** with **Changes and files** adds the files the changes refer to. On import, they are copied in and checked. Exchange files are limited to 2 GB: move large files through a shared folder or a USB copy of the project (see [Exchange files and shared folders](24-exchange-files-and-shared-folders.md)).
