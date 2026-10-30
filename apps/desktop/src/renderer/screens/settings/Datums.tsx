/**
 * Settings, Datums: the geoid grids that give heights above sea level (moved from Offline maps),
 * with their vertical datum notes. Shared by every project on this workstation.
 */
import type { ReactElement } from 'react';
import { GeoidPacks } from './GeoidPacks';

export function Datums(): ReactElement {
  return (
    <div data-settings-focus="geoid">
      <GeoidPacks />
    </div>
  );
}
