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
  'titlebar.copyOf': 'Copy of {file}',
  'titlebar.copyOfTip':
    'Extracted from the package {file} (exported {exported}) on {extracted}. Changes here stay in this project; the package is unchanged.',

  // Packages: extract to edit, map regions
  'package.extract.title': 'Edit a copy',
  'package.extract.text':
    'Extract this package into a new project in your data folder: every layer, issue and edit comes along, and you can annotate and change it. The package file stays as it is.',
  'package.extract.button': 'Extract to edit',
  'package.extract.forbidden':
    'The sender did not allow editing this package. Ask them for a package that allows extract to edit.',
  'package.extract.progress': '{done} of {total}',
  'package.extract.cancel': 'Cancel',
  'package.export.allowEdit': 'Allow the customer to extract an editable copy',
  'package.export.mapPack': 'Include the map region for this site',
  'package.export.mapHelp':
    'Clipped from an installed map pack: the site plus a margin. The player uses it when its machine has no map pack for the site.',
  'package.export.mapZoom': 'Detail up to zoom',
  'package.export.mapMargin': 'Margin',
  'package.export.mapMarginKm': '{km} km',
  'package.export.mapFrom': 'From {pack}: {tiles} tiles, {size}',

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
  'settings.maps.fromPackage': 'In open package',
  'settings.maps.resume': 'Resume',
  'settings.maps.again': 'Download again',
  'settings.maps.interrupted':
    'The download stopped at {size}. Resume continues from there with the same planet build {build}; the finished pack is checked tile by tile.',

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
} as const satisfies Record<string, string>;

/** Every key in the catalogue, plural forms included. */
export type CatalogueKey = keyof typeof en;
