# @aio/workspace

The renderer state every panel shares: the open project, the project clock (UTC ms) and playback, the active video clip, selection, layer visibility, issues, the focused window (for agents) and camera requests. Owned by the integration lead; panels read it with `useWorkspace(selector)` and change it only through its actions.

Asset URLs: `assetUrl(projectId, ref)` gives `aio://project/<projectId>/<path>`, served by the main process with range requests.
