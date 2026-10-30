/**
 * English UI strings: Ask AI and local models. Prefixes: `askAi`, `localAi`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enAskAi = {
  // M8 C7: the local model in Settings, AI providers (the person's own server, nothing bundled)
  'localAi.title': 'Local model',
  'localAi.sub': 'Ollama, LM Studio or a llama.cpp server',
  'localAi.use': 'Use a local model',
  'localAi.useHint':
    'Route a task to Local model below. While the address is on this machine nothing leaves this workstation, so it works with cloud AI off and in projects that forbid cloud AI.',
  'localAi.address': 'Address',
  'localAi.addressLabel': 'Local model address',
  'localAi.model': 'Model',
  'localAi.modelLabel': 'Local model name',
  'localAi.saveError': 'Use an address such as http://localhost:11434/v1 and a model name.',
  'localAi.find': 'Find models',
  'localAi.finding': 'Looking',
  'localAi.server.ollama': 'Ollama',
  'localAi.server.openai': 'OpenAI-compatible server',
  'localAi.found_one': '{server} at {address}: {count} model',
  'localAi.found_other': '{server} at {address}: {count} models',
  'localAi.models': 'Models on the server',
  'localAi.choose': 'Use {model}',
  'localAi.chosen': 'In use',
  'localAi.badge.tools': 'Tools',
  'localAi.badge.vision': 'Vision',
  'localAi.badge.context': '{size} context',
  'localAi.remoteWarn':
    '{address} is on another machine. Requests to it leave this workstation, so they count as cloud AI.',
  'localAi.remoteContinue': 'Look there anyway',
  'localAi.cancel': 'Cancel',
  'localAi.test': 'Test',
  'localAi.testing': 'Testing',
  'localAi.yes': 'yes',
  'localAi.no': 'no',
  'localAi.tested': 'Tools {tools}, vision {vision}. First answer in {seconds} s.',
  'localAi.answerOnly': 'This model cannot call tools: the agent will answer in text only.',
  'localAi.profile': 'Tool list',
  'localAi.profileHint': 'Compact offers fewer tools with short descriptions, for small models.',
  'localAi.profile.full': 'Full',
  'localAi.profile.compact': 'Compact',
  'localAi.wait': 'Wait for the first answer',
  'localAi.waitHint':
    'A model may need time to load, most of all on a computer without a graphics card.',
  'localAi.wait.option': '{minutes} min',
  'localAi.key': 'Server key',
  'localAi.keyHint':
    'Only for a server that asks for one, such as LM Studio or a secured llama.cpp server. Kept in the system vault, never in the settings file.',
  'localAi.keyLabel': 'Local server key',
  'localAi.keyPlaceholder': 'Optional',
  'localAi.keySave': 'Save key',
  'localAi.keyStored': 'Key stored',
  'localAi.keyReplace': 'Replace key',
  'localAi.keyShort': 'That key is too short. Paste the whole key.',
  'localAi.keyFailed': 'The system vault did not accept the key.',
  'localAi.offline': 'Offline agent',
  'localAi.offlineHint':
    'Routes agent chat, vision, report writing, extraction and building from drawings to the local model in one step. Turn it off to go back to the routes before.',
  'localAi.offlineOn': 'Every task runs on {model}. Nothing leaves this machine.',
  'localAi.offlineRemote': 'Every task runs on {model}, on another machine: data leaves this one.',
  'localAi.guide.title': 'Set up a local model',
  'localAi.guide.intro':
    'No model comes with the app. Install one of these free servers yourself, then download a model with tool calling. A model that also has vision can look at photos.',
  'localAi.guide.ollama':
    'Ollama: install it from ollama.com, then download a model marked tools in its library with ollama pull and the model name. It listens on port 11434.',
  'localAi.guide.lmstudio':
    'LM Studio: install it from lmstudio.ai, download a model with tool use in its Discover tab, then start the server in its Developer tab. It listens on port 1234.',
  'localAi.guide.llamacpp':
    'llama.cpp server: start llama-server with a GGUF model and the --jinja option, which tool calling needs. It listens on port 8080.',
  'localAi.guide.then':
    'Then press Find models, choose the model and press Test. Turn on Offline agent to run every task on it.',
  'localAi.guide.hardware':
    'Small models answer more slowly and make more mistakes than cloud models. Without a graphics card an answer can take tens of seconds. Choose Compact for a model with a small context window.',
  'localAi.guide.licence':
    'You install the model, so its licence terms apply to you. Check them before you use it for work.',

  // Ask AI
  'askAi.button': 'Ask AI',
  'askAi.scope': 'Look at',
  'askAi.scope.photo': 'This photo',
  'askAi.scope.selected': 'Selected ({count})',
  'askAi.scope.all': 'All ({count})',
  'askAi.scope.frames': 'Frames…',
  'askAi.frames.source': 'Clip or walk',
  'askAi.frames.every': 'One frame every {s} s',
  'askAi.frames.count_one': '{count} frame',
  'askAi.frames.count_other': '{count} frames',
  'askAi.frames.capped':
    'At most {max} frames per run. Pick a longer interval to cover the whole video.',
  'askAi.checks': 'Look for',
  'askAi.checks.current': 'Look for: {name}',
  'askAi.check.everything': "Everything in this project's classes",
  'askAi.check.detector': '{name} (local detector)',
  'askAi.none': 'No AI can look at this. {reason}',
  'askAi.openSettings': 'Open AI settings',
  'askAi.openTools': 'Open Processing tools',
  'askAi.detectors.checking': 'Checking the Analytics pack and the graphics card.',
  'askAi.reason.noBackend':
    'Install a local model or detector in Settings, or allow cloud AI for this project.',
  'askAi.reason.walkLocal': 'Walk frames need the local model.',
  'askAi.reason.detectorPhotos': 'Local detectors look at photos only.',
  'askAi.reason.nothing': 'Pick a photo first.',
  'askAi.mapping.keepName': 'Keep the name',
  'askAi.run.photos_one':
    'AI is checking {count} photo for {what} · {done} done · suggestions appear as they arrive',
  'askAi.run.photos_other':
    'AI is checking {count} photos for {what} · {done} done · suggestions appear as they arrive',
  'askAi.run.frames_one':
    'AI is checking {count} frame for {what} · {done} done · suggestions appear as they arrive',
  'askAi.run.frames_other':
    'AI is checking {count} frames for {what} · {done} done · suggestions appear as they arrive',
  'askAi.run.queued': 'Waiting for the local detector to be free',
  'askAi.run.done_one': 'AI checked {count} photo and found {found}.',
  'askAi.run.done_other': 'AI checked {count} photos and found {found}.',
  'askAi.run.doneFrames_one': 'AI checked {count} frame and found {found}.',
  'askAi.run.doneFrames_other': 'AI checked {count} frames and found {found}.',
  'askAi.run.stopping': 'Stopping after {done} of {count}. What arrived is kept.',
  'askAi.run.stopped': 'Stopped after {done} of {count}.',
  'askAi.run.failed': 'The AI run stopped: {error}',
  'askAi.run.stop': 'Stop',
  'askAi.run.retry_one': 'Try the {count} left again',
  'askAi.run.retry_other': 'Try the {count} left again',
  'askAi.run.retryTip_one': 'Sends the {count} left to {provider} again.',
  'askAi.run.retryTip_other': 'Sends the {count} left to {provider} again.',
  'askAi.run.retryConfirm':
    'The AI settings have changed since you said yes to this run. Press Ask AI again to see what is sent and where.',
  'askAi.run.review_one': 'Review {count} suggestion',
  'askAi.run.review_other': 'Review {count} suggestions',
  'askAi.run.close': 'Close',
  'askAi.cloud.confirm_one': 'Send {count} photo to {provider}, about {cost}?',
  'askAi.cloud.confirm_other': 'Send {count} photos to {provider}, about {cost}?',
  'askAi.cloud.confirmFrames_one': 'Send {count} frame to {provider}, about {cost}?',
  'askAi.cloud.confirmFrames_other': 'Send {count} frames to {provider}, about {cost}?',
  'askAi.cloud.send': 'Send',
  'askAi.cloud.cancel': 'Cancel',
  'askAi.cloud.dontAsk': "Don't ask again for this project",
  'askAi.cloud.preview': 'Preview what is sent',

  // Ask AI settings
  'askAi.settings.title': 'AI for Ask AI',
  'askAi.settings.backend': 'Which AI looks',
  'askAi.settings.auto':
    'Automatic: a local detector, then the local model, then cloud AI if the project allows it',
  'askAi.settings.local': 'Local only',
  'askAi.settings.cloud': 'Cloud',
  'askAi.settings.model': 'Local model',
  'askAi.settings.minConfidence': 'Lowest confidence the local model keeps',
  'askAi.settings.tile': 'Look at large photos in tiles',
  'askAi.settings.tileSize': 'Tile size (px)',
  'askAi.settings.overlap': 'Tile overlap (px)',
  'askAi.settings.classMap': 'Local model classes in {project}',
  'askAi.settings.classMapNone': "Open a project to map the model's classes to its classes.",
  'askAi.settings.batch': 'Photos per cloud request',
  'askAi.settings.queueThreshold': 'Review queue: lowest confidence shown at first',
} as const satisfies Record<string, string>;
