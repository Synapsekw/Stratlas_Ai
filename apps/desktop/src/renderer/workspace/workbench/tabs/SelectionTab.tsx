/** Selection (D2): what was clicked on the site, a pile included, or a hint to click something. */
import { useIsRoad } from '../../../road/useRoadMap';
import { SelectionBody } from '../FrontBody';

export function SelectionTab() {
  const road = useIsRoad();
  return <SelectionBody road={road} />;
}
