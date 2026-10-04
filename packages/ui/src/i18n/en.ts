/**
 * English UI strings for the main shell (title bar, sidebar, settings). The source catalogue:
 * every other locale is checked against it (`catalogueProblems`). Keys are `area.thing`;
 * plurals use `_one` / `_other` suffixes picked by `Intl.PluralRules`; placeholders are
 * `{name}`. The product name is never written here; pass it as `{product}` from @aio/brand.
 * No em or en dashes.
 */
export const en = {
  // Sections (sidebar, breadcrumb)
  'nav.projects': 'Projects',
  'nav.welcome': 'Welcome',
  'nav.scene': 'Scene',
  'nav.review': 'Original review',
  'nav.issues': 'Issues',
  'nav.media': 'Media',
  'nav.reports': 'Reports',
  'nav.jobs': 'Jobs',
  'nav.settings': 'Settings',
  'nav.sections': 'Sections',
  'nav.primary': 'Primary',
  'nav.collapse': 'Collapse',
  'nav.collapseSidebar': 'Collapse sidebar',
  'nav.expandSidebar': 'Expand sidebar',
  'nav.noProject': 'No project open',
  'nav.chooseProject': 'Choose a project from the library',

  // Title bar
  'titlebar.location': 'Location',
  'titlebar.project': 'Project',
  'titlebar.search': 'Search projects, layers, issues',
  'titlebar.offline': 'Offline',
  'titlebar.offlineTip': 'Runs with no network. Projects, maps and models are local.',
  'titlebar.cloudOn': 'Cloud AI',
  'titlebar.cloudOff': 'Cloud AI off',
  'titlebar.cloudOnTip': 'Cloud AI is allowed. Change in Settings.',
  'titlebar.cloudOffTip': 'Cloud AI is off. Change in Settings.',
  'titlebar.cloudBlocked': 'Cloud AI blocked',
  'titlebar.cloudBlockedTip':
    'This package does not allow cloud AI. Nothing is sent to any provider.',
  'titlebar.readOnlyPackage': 'Read-only package',
  'titlebar.package': 'Package',
  'titlebar.readOnlyPackageTip': 'Opened from {file}. Nothing in this package can be changed.',
  'titlebar.packageTip': 'Opened in place from {file}. Issues are not saved into the package.',

  // Stage tools
  'stage.pins.show': 'Show issue pins',
  'stage.pins.hide': 'Hide issue pins',
  'stage.pins.toggle': 'Turn issue pins off or on',

  // Timeline
  'timeline.title': 'Timeline',
  'timeline.show': 'Show the timeline',
  'timeline.hide': 'Hide the timeline',
  'timeline.toggle': 'Show or hide the timeline',
  'timeline.noVideo': 'No video in this project',
  'timeline.clips_one': '{count} clip',
  'timeline.clips_other': '{count} clips',

  // Library
  'library.count_one': '{count} project',
  'library.count_other': '{count} projects',

  // Stage environment (backdrop, sun and time of day, water)
  'stage.env.button': 'Environment and time of day',
  'stage.env.title': 'Environment',
  'stage.env.backdrop': 'Backdrop',
  'stage.env.sky': 'Sky',
  'stage.env.studio': 'Studio',
  'stage.env.skyHint': 'Daylight from the sun over the site at the date and time below.',
  'stage.env.studioHint': 'Neutral dark backdrop with a fixed light, for a single asset.',
  'stage.env.noLocation':
    'The project has no geographic origin, so the sun cannot be placed. The light stays fixed.',
  'stage.env.date': 'Date',
  'stage.env.time': 'Time',
  'stage.env.timeOfDay': 'Time of day',
  'stage.env.utc': 'UTC{offset}',
  'stage.env.sun': 'Sun {elevation}° up, bearing {azimuth}°',
  'stage.env.night': 'Sun {elevation}° below the horizon, moonlight',
  'stage.env.captureTime': 'Capture time',
  'stage.env.now': 'Now',
  'stage.env.water': 'Water',
  'stage.env.waterLevel': 'Level',
  'stage.env.waterUnit': 'm EL',
  'stage.env.waterFromData': 'Sea level from the project data: EL {level} m.',
  'stage.env.waterSet': 'Water drawn at the level set here. Clear it to use the project data.',
  'stage.env.waterNone': 'No sea level in the project data. Enter a level to draw water.',
  'stage.env.reset': 'Project defaults',
  'settings.graphics.water': 'Water',
  'settings.graphics.waterHint': 'Sea surface: animated waves, or still on integrated graphics',
  'settings.graphics.waterFull': 'Animated',
  'settings.graphics.waterSimple': 'Still',
  'settings.graphics.shadowSoftness': 'Shadow edges',
  'settings.graphics.shadowSoftnessHint': 'Softness of sun shadows, texels',
  'library.build': '{product} {version} · built {date}',

  // Dataset tree: eyes over all layers and over a group
  'tree.eye.all': 'All layers',
  'tree.eye.hideAll': 'Hide all layers',
  'tree.eye.showAll': 'Show all layers',
  'tree.eye.showAllMixed': 'Show all layers (some are hidden)',
  'tree.eye.hideGroup': '{group}: hide all',
  'tree.eye.showGroup': '{group}: show all',
  'tree.eye.showGroupMixed': '{group}: show all (some are hidden)',

  // Scene stage: seeing inside the asset (cut or see-through, never automatic)
  'stage.cutaway.tool': 'See inside the asset: cut or transparent',
  'stage.cutaway.title': 'Inside the asset',
  'stage.cutaway.modes': 'Asset view',
  'stage.cutaway.off': 'Off',
  'stage.cutaway.cut': 'Cut',
  'stage.cutaway.transparent': 'Transparent',
  'stage.cutaway.offHint': 'The asset is drawn solid. Nothing is cut or faded automatically.',
  'stage.cutaway.cutHint':
    'Cuts the asset open toward you: at the drone while it is inside, else through the middle. Point clouds hide meanwhile.',
  'stage.cutaway.transparentHint':
    'Draws the asset see-through, so the drone, its path and its video inside stay visible. Point clouds hide meanwhile.',
  'stage.cutaway.opacity': 'Opacity',
  'stage.cutaway.insideView': 'Inside view',
  'stage.cutaway.insideViewTip': 'Fly behind the drone and look where it looks',
  'stage.cutaway.droneOutside': 'Inside view needs the drone inside the asset',
  'stage.cutaway.droneInside': 'Drone inside the asset',
  'stage.cutaway.cutAtDrone': 'Cut open at the drone, clouds hidden',
  'stage.cutaway.cutOpen': 'Cut open, clouds hidden',
  'stage.cutaway.seeThrough': 'Asset transparent, clouds hidden',
  'stage.cutaway.solid': 'Solid',
  'stage.cutaway.solidTip': 'Draw the asset solid again',

  // Scene stage: what each side of the split shows
  'stage.split.left': 'Left side shows',
  'stage.split.right': 'Right side shows',
  'stage.pane.3d': '3D view',
  'stage.pane.map': 'Map',
  'stage.pane.video': 'Video',
  'stage.pane.photo': 'Photos',
  'stage.pane.raster': 'Ortho and plans',
  'stage.pane.report': 'Report',
  'stage.pane.noClip': 'No clip is active. Pick one on the timeline or in Media.',
  'stage.pane.noPhoto': 'This project has no photos.',
  'stage.pane.prevPhoto': 'Previous photo',
  'stage.pane.nextPhoto': 'Next photo',
  'stage.pane.photoCount': '{n} of {total}',
  'stage.pane.whichRaster': 'Raster layer',
  'stage.pane.whichReport': 'Report file',
  'stage.pane.loading': 'Loading',
  'stage.pane.rasterError': 'The raster could not be shown ({error}).',
  'stage.pane.fit': 'Fit the whole raster',

  // Scene stage: floating video window
  'stage.video.window': 'Video {name}',
  'stage.video.titleBar': 'Video window title bar',
  'stage.video.moveHint':
    'Drag to move, double-click to reset. Arrow keys move, plus and minus resize.',
  'stage.video.resize': 'Resize the video window',
  'stage.video.float': 'Float over the stage',
  'stage.video.floatLabel': 'Float the video window',
  'stage.video.dock': 'Dock beside the stage',
  'stage.video.dockLabel': 'Dock the video window',
  'stage.video.hide': 'Hide video window',
  'stage.video.hideLabel': 'Hide the video window',

  // Settings navigation
  'settings.title': 'Settings',
  'settings.sections': 'Settings sections',
  'settings.group.intelligence': 'Intelligence',
  'settings.group.data': 'Data',
  'settings.group.app': 'App',
  'settings.page.ai': 'AI providers',
  'settings.page.usage': 'Usage and cost',
  'settings.page.privacy': 'Privacy and cloud',
  'settings.page.data': 'Data folder',
  'settings.page.maps': 'Offline maps',
  'settings.page.severity': 'Severity models',
  'settings.page.appearance': 'Appearance',
  'settings.page.about': 'About and updates',
  'settings.page.graphics': 'Graphics quality',
  'settings.notSaved': 'Settings are not being saved: {error}',

  // Page introductions
  'settings.usage.text':
    'Tokens the agent used and their estimated cost, per project and provider, on this workstation.',
  'settings.ai.text':
    'Keys go to the system credential vault. They never enter project files or logs, and the app never shows a stored key.',
  'settings.privacy.text':
    '{product} works fully offline. Cloud AI is opt-in, and every action that sends data or changes the project asks you first.',
  'settings.data.text': 'Where projects and offline map packs live on this workstation.',
  'settings.severity.text':
    'Each project grades issues with its own model. Levels carry a colour, criteria and a recommended action.',

  // Appearance
  'settings.appearance.text':
    'Theme and layout direction. Dark is the working theme; light suits bright rooms and printouts.',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.dark': 'Dark',
  'settings.appearance.light': 'Light',
  'settings.appearance.system': 'System',
  'settings.appearance.systemNow': 'Follows Windows, now {theme}',
  'settings.appearance.direction': 'Layout direction',
  'settings.appearance.ltr': 'Left to right',
  'settings.appearance.rtl': 'Right to left',
  'settings.appearance.directionHelp':
    'Right to left mirrors the panels for Arabic. Arabic text is not translated yet; maps, timelines and the 3D view keep their orientation.',
  'settings.appearance.language': 'Language',
  'settings.appearance.english': 'English',

  // Report branding
  'settings.page.branding': 'Report branding',
  'settings.branding.text':
    'Your company name and logo on the reports {product} generates. Delivered reports are never changed.',
  'settings.branding.neutral':
    'Reports are neutral now: the project name, no company and no logo, with a small "Made with {product}" line.',
  'settings.branding.custom': 'Every report you generate carries this branding.',
  'settings.branding.company': 'Company name',
  'settings.branding.companyPlaceholder': 'Your company',
  'settings.branding.companyHelp': 'On the report cover and at the foot of every page.',
  'settings.branding.logo': 'Logo',
  'settings.branding.logoHelp':
    'PNG, JPG or SVG up to 5 MB. Kept in this workstation profile, never in a project folder.',
  'settings.branding.noLogo': 'No logo',
  'settings.branding.pickLogo': 'Choose logo',
  'settings.branding.replaceLogo': 'Replace logo',
  'settings.branding.removeLogo': 'Remove logo',
  'settings.branding.pickTitle': 'Choose a logo for reports',
  'settings.branding.images': 'Images',
  'settings.branding.accent': 'Accent colour',
  'settings.branding.accentHelp': 'Report cover and headings. Reset to use the house colour.',
  'settings.branding.accentReset': 'Reset',
  'settings.branding.accentDefault': 'House colour',
  'settings.branding.preview': 'Cover preview',
  'settings.branding.previewKicker': 'Issue register',
  'settings.branding.previewTitle': 'Project name',
  'settings.branding.credit': 'Made with {product}',
  'reports.brandingHint':
    'Carries your company name and logo from Settings, Report branding. Without them it is neutral.',
  'builder.reportBranding':
    'Reports carry your own company name and logo from Settings, Report branding.',

  // Maps
  'settings.maps.text':
    'Vector map packs render with no network. They are shared by every project on this workstation.',
  'settings.maps.installed': '{count} · {size}',
  'settings.maps.add': 'Add a region',
  'settings.maps.import': 'Import pack file',
  'settings.maps.online':
    'This downloads map data from build.protomaps.com. It is the only download the app makes, and only when you start it.',
  'settings.maps.offlineOnly':
    'This workstation is offline-only. Import a pack file, or turn off offline-only in Privacy and cloud.',
  'settings.maps.remove': 'Remove',
  'settings.maps.removeConfirm':
    'Remove {label}? Maps lose this area until the pack is added again.',

  // About
  'settings.graphics.text':
    'Presets matched to the graphics card, detected when the app starts. Choose one to override it on this workstation.',
  'settings.about.text': 'Version, licences, logs and updates.',
  'settings.about.version': 'Version',
  'settings.about.build': 'Build {date} ({commit})',
  'settings.about.dataFolder': 'Data folder',
  'settings.about.logs': 'Logs',
  'settings.about.exportLogs': 'Export logs',
  'settings.about.licences': 'Third-party licences',
  'settings.about.installFromFile': 'Install update from file',
  'settings.about.checkOnline': 'Check for updates online',
  // Jobs: inspection pipeline form
  'jobs.inspection.detections': 'Detections',
  'jobs.inspection.detectionsHelp':
    'aio.detections/1 files or folders, from review, AI or a local model. Empty: the project detections folder.',
  'jobs.inspection.drafts': 'Unreviewed AI detections',
  'jobs.inspection.draftsLeaveOut': 'Leave out until a person accepts them',
  'jobs.inspection.draftsCount': 'Count them too',
  'jobs.inspection.minConfidence': 'Minimum confidence',
  'jobs.inspection.minConfidenceHint': '0 to 1, optional',
  'jobs.inspection.clusterM': 'Group detections within (m)',
  'jobs.inspection.clusterMHint': 'Kit default',
  'jobs.inspection.hfovDeg': 'Field of view for photos without a lens (deg)',
  'jobs.inspection.hfovDegHelp': 'The kit default is 70 degrees.',
  'jobs.inspection.out': 'Output folder',
} as const satisfies Record<string, string>;

/** Every key in the catalogue, plural forms included. */
export type CatalogueKey = keyof typeof en;
