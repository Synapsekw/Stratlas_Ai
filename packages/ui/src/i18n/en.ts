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

  // Library
  'library.count_one': '{count} project',
  'library.count_other': '{count} projects',
  'library.build': '{product} {version} · built {date}',

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

  // Video calibration (builder, BLD-3)
  'calibrate.title': 'Calibrate video',
  'calibrate.close': 'Close',
  'calibrate.noClip': 'This project has no video clip with a flight.',
  'calibrate.clip': 'Clip',
  'calibrate.frame': 'Frame',
  'calibrate.frameOpacity': 'Frame opacity',
  'calibrate.tag':
    '{clip} · FOV {fov}° · offset {offset} ms · pitch {pitch}° yaw {yaw}° roll {roll}° · up {up} m',
  'calibrate.time.title': 'Time offset',
  'calibrate.time.help':
    'Scrub the timeline to a visible event (a turn, a vehicle, the take-off) and nudge until the frame and the model move together.',
  'calibrate.time.input': 'Time offset in milliseconds',
  'calibrate.time.ms': 'ms',
  'calibrate.time.back1s': '-1 s',
  'calibrate.time.back1f': '-1 frame',
  'calibrate.time.fwd1f': '+1 frame',
  'calibrate.time.fwd1s': '+1 s',
  'calibrate.fov.title': 'Field of view',
  'calibrate.fov.help':
    'Drag across the frame to widen or narrow the model view until edges line up, or fit it from point pairs.',
  'calibrate.fov.slider': 'Horizontal field of view',
  'calibrate.fov.input': 'Horizontal field of view in degrees',
  'calibrate.orient.title': 'Orientation',
  'calibrate.orient.help':
    'Turn the camera against its flight log until the model sits on the frame: pitch tilts the view up or down, yaw turns it left or right, roll turns it about the view axis.',
  'calibrate.orient.pitch': 'Pitch',
  'calibrate.orient.yaw': 'Yaw',
  'calibrate.orient.roll': 'Roll',
  'calibrate.orient.slider': '{axis} offset',
  'calibrate.orient.input': '{axis} offset in degrees',
  'calibrate.orient.auto': 'Refine automatically',
  'calibrate.orient.autoTip': 'Line the frame up with the model by their edges on this frame',
  'calibrate.orient.autoRunning': 'Comparing the frame with the model',
  'calibrate.orient.autoDone':
    'Refined by edges: pitch {pitch}°, yaw {yaw}°, roll {roll}° (edge match {before} to {after}).',
  'calibrate.orient.autoWeak':
    'The edges do not agree clearly on this frame (edge match {after}). Try a frame with more of the plant in view, or pick point pairs.',
  'calibrate.orient.autoPinhole': 'Automatic refine needs a pinhole lens.',
  'calibrate.orient.autoNoFrame': 'The video frame is not ready yet. Try again in a moment.',
  'calibrate.pos.title': 'Position',
  'calibrate.pos.help':
    'Move the camera from its logged position, in metres. Drone logs often carry a height from a take-off point that is not plant grade: near objects then slide against the model while far ones hold. Fit it from point pairs near and far.',
  'calibrate.pos.east': 'East',
  'calibrate.pos.north': 'North',
  'calibrate.pos.up': 'Up',
  'calibrate.pos.input': '{axis} offset in metres',
  'calibrate.pos.unit': '{axis} (m)',
  'calibrate.pos.enu': 'east {e} m, north {n} m, up {u} m',
  'calibrate.pairs.title': 'Point pairs',
  'calibrate.pairs.help':
    'Click a sharp feature in the frame, then the same feature on the model, or type its coordinate. Three to six pairs spread over the frame; scrub to another moment to add pairs there too.',
  'calibrate.pairs.add': 'Add pair',
  'calibrate.pairs.fit': 'Fit',
  'calibrate.pairs.clear': 'Clear',
  'calibrate.pairs.fitWhat': 'Values to fit',
  'calibrate.pairs.fitOrientation': 'Orientation',
  'calibrate.pairs.fitPosition': 'Position',
  'calibrate.pairs.fitFov': 'Field of view',
  'calibrate.pairs.fitTime': 'Time offset',
  'calibrate.pairs.table': 'Point pairs',
  'calibrate.pairs.colFrame': 'Frame x y',
  'calibrate.pairs.colError': 'Error now',
  'calibrate.pairs.remove': 'Remove pair {n}',
  'calibrate.pairs.behind': 'behind',
  'calibrate.pairs.px': '{value} px',
  'calibrate.say.clickFrame': 'Click a sharp feature in the video frame.',
  'calibrate.say.clickModel': 'Now click the same feature on the model, or type its coordinate.',
  'calibrate.say.added': 'Pair added. Add more across the frame, then fit.',
  'calibrate.say.nothing': 'Nothing under the cursor. Click the model.',
  'calibrate.say.typeCoord': 'Type E N H in the project CRS, or lat, lon, h.',
  'calibrate.say.fitted_one': 'Fitted from {count} pair: {values}.',
  'calibrate.say.fitted_other': 'Fitted from {count} pairs: {values}.',
  'calibrate.coord.placeholder': 'or type E N H of the feature',
  'calibrate.coord.label': 'Feature coordinate',
  'calibrate.coord.add': 'Add',
  'calibrate.stats.before': 'Before fit',
  'calibrate.stats.now': 'Error now',
  'calibrate.stats.heldOut': 'Held out',
  'calibrate.stats.heldOutTip': 'Each pair against a fit made without it',
  'calibrate.save.lensAll_one': 'Use this lens for the {count} clip with this frame size',
  'calibrate.save.lensAll_other': 'Use this lens for all {count} clips with this frame size',
  'calibrate.save.orientFlight_one':
    'Use this orientation and position for the {count} clip of this flight',
  'calibrate.save.orientFlight_other':
    'Use this orientation and position for all {count} clips of this flight',
  'calibrate.save.button': 'Save calibration',
  'calibrate.save.reset': 'Reset',
  'calibrate.save.done':
    'Saved: offset {offset} ms, field of view {fov}°, orientation pitch {pitch}° yaw {yaw}° roll {roll}°, position {position}, {clips}.',
  'calibrate.save.clips_one': '{count} clip',
  'calibrate.save.clips_other': '{count} clips',
} as const satisfies Record<string, string>;

/** Every key in the catalogue, plural forms included. */
export type CatalogueKey = keyof typeof en;
