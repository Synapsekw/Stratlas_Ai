/**
 * English UI strings: settings pages. Prefixes: `settings`, `identity`, `classes`, `graphics`, `mapSources`, `tools`, `blobs`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enSettings = {
  'settings.graphics.water': 'Water',
  'settings.graphics.waterHint': 'Sea surface: animated waves, or still on integrated graphics',
  'settings.graphics.waterFull': 'Animated',
  'settings.graphics.waterSimple': 'Still',
  'settings.graphics.shadowSoftness': 'Shadow edges',
  'settings.graphics.shadowSoftnessHint': 'Softness of sun shadows, texels',
  'settings.graphics.maxTexture': 'Largest texture',
  'settings.graphics.maxTextureHint':
    'Model and ortho images above this edge are scaled down, pixels',
  'settings.graphics.pointCap': 'Point limit',
  'settings.graphics.pointCapHint': 'Most points the point cloud panel can choose',
  'settings.graphics.memoryLimit': 'Graphics memory',
  'settings.graphics.memoryLimitHint':
    'Estimate at which the app steps down a preset for the session',
  'settings.graphics.memory': 'Installed memory: {size} GB',
  'settings.graphics.limitMemory': 'Auto stays at {tier} or below with {size} GB of memory.',
  'settings.graphics.limitTexture':
    'Auto stays at Low: the graphics card keeps textures under 8192 px.',
  'settings.graphics.pressure':
    'Stepped down to {tier} for this session after graphics memory ran low. Choosing a preset here resets it.',
  'graphics.pressure.title': 'Lighter graphics for now',
  'graphics.pressure.memory':
    'Graphics memory was running low, so the {tier} preset is in use for this session. Fewer points are drawn; nothing was lost.',
  'graphics.pressure.contextLost':
    'The graphics card reset. The view is back with the {tier} preset for this session; nothing was lost.',
  'graphics.pressure.dismiss': 'Dismiss',

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
  'settings.page.mapSources': 'Map sources',
  'settings.page.severity': 'Severity models',
  'settings.page.classes': 'Classes',
  'settings.page.appearance': 'Appearance',
  'settings.page.about': 'About and updates',
  'settings.page.graphics': 'Graphics quality',
  'settings.notSaved': 'Settings are not being saved: {error}',

  // Page introductions
  'settings.usage.text':
    'Tokens the agent used and their estimated cost, per project and provider, on this workstation.',
  'settings.ai.text':
    'Keys go to the system credential vault. They never enter project files or logs, and the app never shows a stored key.',
  'settings.ai.workspaceInvalid':
    'A workspace ID has only letters, digits, _ and -, such as wrkspc_01AbC.',
  'settings.ai.workspaceNeeded':
    'Anthropic needs the workspace ID for this key. Enter it above, then test again.',
  'settings.privacy.text':
    '{product} works fully offline. Cloud AI is opt-in, and every action that sends data or changes the project asks you first.',
  'settings.data.text': 'Where projects and offline map packs live on this workstation.',

  // Settings, Processing tools (the pipeline pack) and its start notice
  'settings.page.tools': 'Processing tools',
  'settings.tools.text':
    'The tools that build maps and models from your data. They run on this computer.',
  'tools.title': 'On this computer',
  'tools.how':
    'The processing tools come as one file beside the installer, pipeline-pack-<version>-<platform>.tar.gz (about 400 MB), and are kept in the data folder. Updating {product} does not update them: install the file that came with the new version here.',
  'tools.status': 'Status',
  'tools.version': 'Version',
  'tools.location': 'Location',
  'tools.size': 'Size',
  'tools.none': 'None',
  'tools.looking': 'Looking',
  'tools.state.ok': 'Up to date',
  'tools.state.tooOld': 'Too old for this version of {product}',
  'tools.state.missing': 'Not installed',
  'tools.state.incompatible': 'Not made for this version of {product}',
  'tools.state.dev': 'Set by this computer',
  'tools.dev':
    'The tools come from QUADRION_PIPELINE_PYTHON or QUADRION_PIPELINE_PACK on this computer. Tools installed here are used once that is unset.',
  'tools.install': 'Install or update from file',
  'tools.installHint':
    'Choose the processing tools file, pipeline-pack-<version>-<platform>.tar.gz. It is checked, then installed into the data folder. Nothing is downloaded.',
  'tools.choose': 'Choose file',
  'tools.offer': 'Install version {version} found in {where}',
  'tools.offerTitle': 'A newer version is on this computer',
  'tools.where.downloads': 'Downloads',
  'tools.where.app': 'the app folder',
  'tools.where.runtime': 'the data folder',
  'tools.progress.unpack': 'Unpacking: {done} of {total}',
  'tools.progress.files': '{files} files',
  'tools.progress.check': 'Checking the files',
  'tools.progress.activate': 'Finishing',
  'tools.progress.label': 'Installing the processing tools',
  'tools.cancel': 'Cancel',
  'tools.replace.title': 'Version {version} is already installed.',
  'tools.replace.text': 'Replace it with the one in this file?',
  'tools.replace.yes': 'Replace version {version}',
  'tools.replace.no': 'Keep it',
  'tools.installed': 'Processing tools {version} are installed. Processing uses them from now on.',
  'tools.resume.createMaps': 'Create maps from photos',
  'tools.removed': '{name} was moved to the bin.',
  'tools.others.title': 'Versions no longer in use',
  'tools.others.help':
    'Older versions stay in the data folder until you remove them. Remove moves one to the bin of this computer (Recycle Bin or Trash), where it can be restored.',
  'tools.others.incomplete': 'Incomplete',
  'tools.others.remove': 'Remove',
  'tools.others.confirm': 'Move version {version} to the bin',
  'tools.others.keep': 'Keep',
  'tools.others.actions': 'Actions',
  'tools.notice.tooOld.title': 'The processing tools need an update',
  'tools.notice.tooOld':
    'The processing tools on this computer (version {version}) are older than this version of {product} needs. Some jobs do not start until they are updated.',
  'tools.notice.missing.title': 'The processing tools are not installed',
  'tools.notice.missing':
    'Building maps and models from your data needs them. Viewing, measuring and reports work without.',
  'tools.notice.incompatible':
    'The processing tools on this computer are not made for this version of {product}. Processing does not start until they are updated.',
  'tools.notice.update': 'Update processing tools',
  'tools.notice.dismiss': 'Dismiss',
  'settings.severity.text':
    'Each project grades issues with its own model. Levels carry a colour, criteria and a recommended action.',
  'settings.classes.text':
    'The classes this project sorts findings into: name, colour, hotkey and severity scale. Changes are saved in the project; Ctrl+Z undoes them.',

  // Classes (ANN-7)
  'classes.noProject': 'Open a project to edit its classes.',
  'classes.readOnly': 'This project is read-only, so its classes cannot be changed.',
  'classes.notSaved': 'Classes not saved: {error}',
  'classes.created': 'Class {label} created.',
  'classes.scaleCreated': 'Severity scale {label} created.',
  'classes.deleted': 'Class {label} deleted.',
  'classes.savedToLibrary': '{label} saved to your class library.',
  'classes.undo': 'Undo',
  'classes.dismiss': 'Dismiss',
  'classes.empty': 'This project has no classes yet. Create one below.',
  'classes.col.colour': 'Colour',
  'classes.col.name': 'Name',
  'classes.col.hotkey': 'Hotkey',
  'classes.col.severity': 'Severity scale',
  'classes.col.issues': 'Issues',
  'classes.name': 'Name of {label}',
  'classes.hotkey': 'Hotkey of {label}',
  'classes.severity': 'Severity scale of {label}',
  'classes.colour': 'Colour of {label}',
  'classes.severityLocked':
    'Issues use this class. Move them to another class to change its severity scale.',
  'classes.saveToLibrary': 'Save to my class library',
  'classes.delete': 'Delete {label}',
  'classes.delete.title': 'Delete {label}',
  'classes.delete.used': '{issues} and {detections} use {label}. Move them to:',
  'classes.delete.issues_one': '{count} issue',
  'classes.delete.issues_other': '{count} issues',
  'classes.delete.detections_one': '{count} detection',
  'classes.delete.detections_other': '{count} detections',
  'classes.delete.usedOnly': '{issues} and {detections} use {label}.',
  'classes.delete.only':
    '{label} is the only class, so there is nothing to move its issues and detections to. Create another class here first.',
  'classes.delete.checking': 'Checking which issues and detections use {label}.',
  'classes.delete.unused': 'Nothing uses {label}.',
  'classes.delete.unreadable':
    'The detections could not be read, so this class cannot be deleted safely.',
  'classes.delete.confirm': 'Delete',
  'classes.delete.move': 'Move and delete',
  'classes.delete.cancel': 'Cancel',
  'classes.delete.pickTarget': 'Pick the class that takes over its issues and detections.',
  'classes.severityLockedShort': 'Locked while issues use it',

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
  'settings.appearance.access': 'Accessibility',
  'settings.appearance.contrast': 'Increase contrast',
  'settings.appearance.contrastHelp':
    'Brighter secondary text and stronger lines. Off follows Windows (high contrast or more contrast), now {state}.',
  'settings.appearance.motion': 'Reduce motion',
  'settings.appearance.motionHelp':
    'The camera jumps instead of flying, and panels appear without fades. Off follows Windows (animation effects), now {state}.',
  'settings.appearance.osOn': 'on',
  'settings.appearance.osOff': 'off',
  'settings.appearance.launch': 'Launch screen',
  'settings.appearance.launchShow': 'Show launch screen',
  'settings.appearance.launchHelp':
    'A short welcome with your name each time {product} starts. Press Enter or click Enter to go to your projects.',

  // Keyboard map
  'settings.page.keyboard': 'Keyboard',
  'settings.keyboard.text':
    'Every shortcut in {product}, where it works and what it does. Shortcuts never fire while you type in a field.',
  'settings.keyboard.search': 'Search shortcuts',
  'settings.keyboard.searchHint': 'Type a key, an action or a place, e.g. Esc, measure, map',
  'settings.keyboard.key': 'Keys',
  'settings.keyboard.action': 'Action',
  'settings.keyboard.none': 'No shortcut matches "{query}".',
  'settings.keyboard.count_one': '{count} shortcut',
  'settings.keyboard.count_other': '{count} shortcuts',

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

  // Maps
  'settings.mapSources.text':
    'Online maps from named providers, and the keys this computer uses for them. Keys stay on this computer.',
  'settings.maps.text':
    'Vector map packs render with no network. They are shared by every project on this workstation.',
  'settings.maps.installed': '{count} · {size}',
  'settings.maps.add': 'Add a region',
  'settings.maps.import': 'Import pack file',
  'settings.maps.online':
    'This downloads map data from build.protomaps.com, and only when you start it (or have turned on automatic street maps for new projects).',
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
  'settings.about.previous': 'Previous version',
  'settings.about.returnTo': 'Return to {version}',
  'settings.about.whatsNew': "What's new in {version}",
  // M9 T2: identity, members and roles
  'identity.page': 'Identity and team',
  'identity.page.text':
    'Who you are on issues, reviews and the project history, and who works on the open project.',
  'identity.you': 'Your identity',
  'identity.you.help':
    'New issues, reviews and every change in the history carry your name. Your initials show on issue chips.',
  'identity.name': 'Your name',
  'identity.initials': 'Initials',
  'identity.email': 'Email (optional)',
  'identity.initials.invalid': 'Initials are 1 to 3 letters, optionally followed by one digit.',
  'identity.name.invalid': 'Your name needs 1 to 80 characters.',
  'identity.device': 'This computer',
  'identity.device.key': 'Device key {id}, kept in the credential store.',
  'identity.device.none':
    'No device key yet. It is made when you first export your card or change a team.',
  'identity.device.unsigned':
    'The credential store is not available, so your changes are recorded without a signature.',
  'identity.card.export': 'Export identity card',
  'identity.card.help': 'Send your card to a project owner. They add you to their project from it.',
  'identity.card.saved': 'Saved to {path}',
  'identity.members': 'Members of {project}',
  'identity.members.none':
    'This project is not shared. Add a person from their identity card to share it: you become its owner.',
  'identity.members.noProject': 'Open a project to see and manage its members.',
  'identity.members.add': 'Add from card',
  'identity.members.addAs': 'Add as',
  'identity.members.certify': 'Certify this card (you checked it with the person)',
  'identity.members.confirmAdd': 'Add {name}',
  'identity.members.cancel': 'Cancel',
  'identity.members.you': '(you)',
  'identity.members.remove': 'Remove',
  'identity.members.confirmRemove': 'Confirm remove',
  'identity.members.revoke': 'Revoke device',
  'identity.members.confirmRevoke': 'Confirm revoke',
  'identity.members.revoked': 'Revoked',
  'identity.role.owner': 'Owner',
  'identity.role.reviewer': 'Reviewer',
  'identity.role.viewer': 'Viewer',
  'identity.role.client': 'Client',
  'identity.badge.self': 'Unverified',
  'identity.badge.self.title': 'Self-asserted name: no owner has certified it.',
  'identity.badge.byYou': 'Certified by you',
  'identity.badge.owner': 'Owner-certified',
  'identity.badge.server': 'Server-enrolled',
  'identity.badge.account': 'Account',
  'identity.col.person': 'Person',
  'identity.col.role': 'Role',
  'identity.col.identity': 'Identity',
  'identity.col.devices': 'Devices',
  // M9 T6: files on this computer (binaries by content)
  'blobs.title': 'Files on this computer',
  'blobs.files': 'Files',
  'blobs.close': 'Close',
  'blobs.summary_one': '{count} layer is not on this computer',
  'blobs.summary_other': '{count} layers are not on this computer',
  'blobs.notHere': 'Not on this computer ({size})',
  'blobs.downloading': 'Downloading {done} of {total}',
  'blobs.partial': 'Paused at {done} of {total}',
  'blobs.streaming': 'Streaming from the shared folder',
  'blobs.stale': 'Changed since it was shared',
  'blobs.present': 'On this computer',
  'blobs.progress': 'Download of {name}',
  'blobs.download': 'Download',
  'blobs.resume': 'Resume',
  'blobs.cancel': 'Cancel',
  'blobs.policy': 'Get files',
  'blobs.policy.always': 'Always',
  'blobs.policy.on-open': 'When the project opens',
  'blobs.policy.on-demand': 'Only when I download',
  'blobs.policy.stream': 'Stream from shared folder',
  'blobs.cache': 'Download cache: {used} of {cap}',
  // Settings, Map sources
  'mapSources.master': 'Online maps',
  'mapSources.master.help':
    'Off by default. When on, the Map menu offers the online maps below in the Map view, the Globe and the 3D scene. The tiles for the areas you look at are requested from that provider.',
  'mapSources.offlineOnly':
    'This workstation is offline-only, so online maps cannot be switched on. Turn off offline-only in Privacy and cloud.',
  'mapSources.provider.eox': 'Sentinel-2 (EOX)',
  'mapSources.provider.esri': 'Esri World Imagery',
  'mapSources.provider.mapbox': 'Mapbox',
  'mapSources.status.keyless': 'Works without a key',
  'mapSources.status.noKey': 'No key',
  'mapSources.status.saved': 'Key saved',
  'mapSources.key': '{provider} key',
  'mapSources.key.placeholder': 'Paste the key',
  'mapSources.key.check': 'Saving or testing a key asks {provider} for one tile to check it.',
  'mapSources.save': 'Save key',
  'mapSources.test': 'Test',
  'mapSources.remove': 'Remove',
  'mapSources.checking': 'Checking the key with one tile',
  'mapSources.tested': 'The key works.',
  'mapSources.saved': 'The key is saved on this computer.',
  'mapSources.removed': 'The key is removed from this computer.',
  'mapSources.terms.eox':
    'Sentinel-2 cloudless 2016 by EOX, CC BY 4.0. No key and no cost. Tiles are kept on this computer, up to 300 MB.',
  'mapSources.terms.esri':
    'Works without a key. A key from an ArcGIS Location Platform account uses that account and its free monthly allowance. Tiles are not kept on this computer.',
  'mapSources.terms.mapbox':
    'Mapbox Satellite and the Mapbox styles. Needs a public access token from a Mapbox account; requests beyond the free monthly allowance are billed to that account. Tiles are not kept on this computer.',
  'mapSources.clear': 'Clear saved satellite tiles ({size})',
  'mapSources.credit': 'Credit: {attribution}',
  'settings.treatAsVision': 'Treat as vision model',
  'settings.treatAsVisionHint':
    'You vouch that this model reads images and returns structured answers. Used with careful limits.',
  'settings.agentThinking': 'Agent thinking and prompt caching',
  'settings.agentThinkingOn':
    'On: the cloud agent thinks before it acts and reuses the unchanged start of each request, which costs less.',
  'settings.agentThinkingOff':
    'Off: the cloud agent answers without thinking first and every request is sent in full.',
  'settings.task.engineer': 'Engineering models',
  'settings.task.engineerSends': 'Measurements, photos, scan views',
  'settings.autoPrepare.label': 'Prepare survey surfaces when a project opens',
  'settings.autoPrepare.hint': 'Runs in the background and shows in Jobs. You can cancel it.',
  'settings.angles.title': 'Angles',
  'settings.angles.decimal': 'Decimal degrees',
  'settings.angles.dms': 'Degrees, minutes, seconds',
  'settings.angles.bearings': 'Bearings',
  'settings.angles.decimals': 'Decimals',
} as const satisfies Record<string, string>;
