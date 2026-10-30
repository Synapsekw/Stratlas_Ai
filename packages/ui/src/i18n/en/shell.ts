/**
 * English UI strings: title bar, sidebar, connection, status, notices, help, diagnostics. Prefixes: `titlebar`, `nav`, `connection`, `status`, `syncNotice`, `diskChanged`, `announce`, `online`, `help`, `diag`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enShell = {
  // Sections (sidebar, breadcrumb)
  'nav.projects': 'Projects',
  'nav.welcome': 'Welcome',
  'nav.scene': 'Scene',
  'nav.issues': 'Issues',
  'nav.inspect': 'Inspect',
  'nav.reports': 'Reports',
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
  'titlebar.online': 'Online',
  'titlebar.offlineOnly': 'Offline only',
  'titlebar.onlineTip':
    'Online: this workstation may use the network for what you turn on or start. Click to change.',
  'titlebar.offlineOnlyTip':
    'Offline only: this workstation makes no network connections. Click to change.',
  'titlebar.cloudOn': 'AI allowed',
  'titlebar.cloudOff': 'AI off',
  'titlebar.cloudOnTip': 'AI is allowed. Change in Settings, Privacy and cloud.',
  'titlebar.cloudOffTip': 'AI is off. Change in Settings, Privacy and cloud.',
  'titlebar.cloudBlocked': 'AI blocked',
  'titlebar.cloudBlockedTip': 'This package does not allow AI. Nothing is sent to any provider.',
  'titlebar.cloudOfflineTip':
    'AI is off because this workstation is offline only. Go online to use it.',
  'titlebar.readOnlyPackage': 'Read-only package',
  'titlebar.package': 'Package',
  'titlebar.readOnlyPackageTip': 'Opened from {file}. Nothing in this package can be changed.',
  'titlebar.packageTip': 'Opened in place from {file}. Issues are not saved into the package.',
  'titlebar.copyOf': 'Copy of {file}',
  'titlebar.copyOfTip':
    'Extracted from the package {file} (exported {exported}) on {extracted}. Changes here stay in this project; the package is unchanged.',

  // The connection menu of the title bar (shell/ConnectionStatus.tsx)
  'connection.title': 'Connection',
  'connection.chip': 'Connection: {mode}',
  'connection.switch': 'Online',
  'connection.onlineText':
    'You can download maps, use cloud AI when it is turned on, connect to a team server and check for updates. Each stays off until you turn it on or start it.',
  'connection.offlineText':
    'This workstation makes no network connections: nothing is sent and nothing is downloaded. Go online to download maps, use cloud AI, connect to a team server or check for updates.',
  'connection.noNetwork': 'This computer has no network connection right now.',
  'connection.maps': 'Download maps',
  'connection.mapsHint': 'Settings, Offline maps',
  'connection.mapsOffline': 'Go online first',
  'connection.cloud': 'AI',
  'connection.on': 'On',
  'connection.off': 'Off',
  'connection.blocked': 'Blocked',
  'connection.goOnline': 'Go online',
  'connection.workOffline': 'Work offline only',

  // Screen reader announcements
  'announce.exportDone': 'Saved {file}',
  'announce.exportFailed': 'Export failed: {error}',
  'announce.jobDone': '{job} finished',
  'announce.jobFailed': '{job} failed',
  'announce.agentReplied': 'The agent replied',

  // Diagnostics and support (Settings, About and updates; Help, Report a problem; crash notice)
  'diag.title': 'Diagnostics and support',
  'diag.text':
    'A diagnostics bundle is a zip with the logs, versions, graphics card, settings without keys, map packs and processing tools, recent jobs and crash reports. It never holds project files, and nothing is sent anywhere: you choose where to save it.',
  'diag.export': 'Export diagnostics',
  'diag.report': 'Report a problem',
  'diag.saving': 'Saving',
  'diag.saved': 'Saved to {path}. Attach that file when you contact support.',
  'diag.problem.title': 'Report a problem',
  'diag.problem.intro':
    'Describe what happened. Your words are saved with the diagnostics bundle as problem.md, in a zip you choose where to put. Nothing is uploaded or emailed.',
  'diag.problem.what': 'What happened',
  'diag.problem.whatHint': 'For example: the map stayed grey after I opened the project.',
  'diag.problem.steps': 'Steps to make it happen again',
  'diag.problem.stepsHint': '1. Open the project  2. Switch to Map  3. ...',
  'diag.problem.save': 'Save report',
  'diag.problem.send': 'Send to Quadrion',
  'diag.problem.sendHelp':
    'Opens the report form on quadrion.ai in your browser. Save the report first to attach its file.',
  'diag.problem.cancel': 'Cancel',
  'diag.problem.done': 'Done',
  'diag.problem.needWhat': 'Write a sentence about what happened first.',
  'diag.crash.closed': '{product} closed unexpectedly last time',
  'diag.crash.window': 'The {product} window stopped unexpectedly and was reopened',
  'diag.crash.text':
    'A report was saved on this computer ({process}, {reason}). Saving it lets you send it to support; nothing is sent automatically.',
  'diag.crash.save': 'Save a report',
  'diag.crash.dismiss': 'Dismiss',
  // User guide (F1): help panel and the "?" links
  'help.title': 'User guide',
  'help.open': 'User guide (F1)',
  'help.search': 'Search the guide',
  'help.contents': 'Contents',
  'help.results': 'Search results',
  'help.count_one': '{count} section',
  'help.count_other': '{count} sections',
  'help.noResults': 'Nothing in the guide matches "{query}".',
  'help.close': 'Close the guide (Esc)',
  'help.topic': 'Help on this',
  // M9 integration: compare-before-write
  'diskChanged.title': 'Not saved',
  'diskChanged.reload': 'Reload',
  'diskChanged.reloading': 'Reloading',
  'diskChanged.dismiss': 'Dismiss',
  'diskChanged.failed': 'Reload did not work: {error}',
  // M9 integration: sync notices (clock ahead, renumbered codes)
  'syncNotice.clockTitle': 'Clock ahead',
  'syncNotice.recodeTitle': 'Issue code changed',
  'syncNotice.clockAhead':
    'The clock of {who} is {ahead} ahead of this computer. Their changes still apply; check the date and time on that computer.',
  'syncNotice.clockHold':
    'The clock of {who} is {ahead} ahead of this computer. Their changes wait in Quarantined until an owner applies them or the clock is fixed.',
  'syncNotice.minutes_one': '{count} minute',
  'syncNotice.minutes_other': '{count} minutes',
  'syncNotice.hours_one': '{count} hour',
  'syncNotice.hours_other': '{count} hours',
  'syncNotice.recode':
    '{to} was {from}. Another issue made apart has that code, so it is now {to}.',
  'syncNotice.delivered': 'Packages already sent with the old code: {packages}.',
  'syncNotice.dismiss': 'Dismiss',
  // Online satellite (ADR 0007, amendment of 10 Oct 2026)
  // Online maps, one notice per provider (ADR 0007, amendment of 14 Oct 2026)
  'online.notice.eox':
    "Sentinel-2 imagery is requested from EOX's servers for the areas you look at, so the areas you view are visible to that service. Nothing else is sent. The imagery is from 2016, at about 10 m per pixel, and the tiles are kept on this computer.",
  'online.notice.esri':
    "Esri World Imagery is requested from Esri's servers for the areas you look at, so the areas you view are visible to Esri. Nothing else is sent. The tiles are not kept on this computer.",
  'online.notice.mapbox':
    "Mapbox maps are requested from Mapbox's servers with your key for the areas you look at, so the areas you view are visible to Mapbox. Nothing else is sent. The tiles are not kept on this computer.",
  'online.confirm': 'Switch on',
  'online.cancel': 'Cancel',
  'status.online': 'Online',
  'status.jobs_one': '{count} job',
  'status.jobs_other': '{count} jobs',
} as const satisfies Record<string, string>;
