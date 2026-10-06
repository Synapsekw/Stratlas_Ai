declare module 'virtual:licenses' {
  import type { LicenseEntry } from '@aio/schema';

  const licenses: LicenseEntry[];
  export default licenses;
}

declare module 'virtual:release-notes' {
  import type { ReleaseNotes } from '@aio/schema';

  const notes: ReleaseNotes;
  export default notes;
}
