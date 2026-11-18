/**
 * English UI strings: the "Find cut and fill regions" dialog (Tools > Measure > Site data), which
 * compares two surfaces in a background job and drafts cut and fill regions. Prefixes:
 * `siteRegions`. Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enSiteRegions = {
  'siteRegions.title': 'Find cut and fill regions',
  'siteRegions.description':
    'Compares two surfaces over their overlap in a background job, then suggests cut and fill regions you can keep as measurements.',
  'siteRegions.totalsHint': 'The totals between two surveys are in Project > Volumes > Cut & fill.',
  'siteRegions.needSurfaces': 'Prepare the survey surfaces first (in a comparison).',
  'siteRegions.from': 'From',
  'siteRegions.to': 'To',
  'siteRegions.deadband': 'Use deadband in calculations ({value} from the heat map stops)',
  'siteRegions.compare': 'Compare',
  'siteRegions.comparing': 'Comparing… {percent}%',
  'siteRegions.stopped': 'The whole-site comparison stopped.',
  'siteRegions.unreadable': '{path} could not be read ({status}).',
  'siteRegions.result': 'Whole-site result',
  'siteRegions.cut': 'Cut',
  'siteRegions.fill': 'Fill',
  'siteRegions.net': 'Net',
  'siteRegions.total': 'Total',
  'siteRegions.partial': 'Partly outside the survey: {reason}',
  'siteRegions.drafts': 'Suggested regions (drafts)',
  'siteRegions.draftCut': 'Cut region {n}: about {volume} over {area}',
  'siteRegions.draftFill': 'Fill region {n}: about {volume} over {area}',
  'siteRegions.snapped': '(snapped to the ortho)',
  'siteRegions.keep': 'Keep {count} as volume measurements',
  'siteRegions.keepNone': 'Keep as volume measurements',
  'siteRegions.snap': 'Snap to ortho edges',
  'siteRegions.snapping': 'Snapping...',
  'siteRegions.snapTip':
    "The local model moves the ticked regions' boundaries to the edges seen in the ortho. They stay drafts.",
  'siteRegions.snapName': 'Snapping to the ortho',
  'siteRegions.snapNote': '{done} of {picked} ticked regions follow the edge in the ortho.',
  'siteRegions.snapKept': 'Region {n}: {reason}',
  'siteRegions.snapKeptAsWas': 'kept as it was.',
} as const;
