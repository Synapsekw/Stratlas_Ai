// Zero-network guard for the Electron main process, preloaded by the e2e fixtures through
// the `-r` flag (Playwright drops NODE_OPTIONS). It runs before the app's own code and makes every outbound
// network call from Node fail fast, recording the target in globalThis.__aioNetworkLog.
// Renderer traffic is guarded separately by the Playwright context route in fixtures.ts.
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS preload for Electron's -r flag. */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { syncBuiltinESMExports } = require('node:module');

/** @type {string[]} */
const log = [];
Object.defineProperty(globalThis, '__aioNetworkLog', { value: log, enumerable: false });

function blocked(target) {
  log.push(target);
  const error = new Error(`Network access blocked by the e2e zero-network guard: ${target}`);
  error.code = 'ENETUNREACH';
  return error;
}

function describeRequest(args) {
  const [first, second] = args;
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.href;
  const opts = first && typeof first === 'object' ? first : second;
  if (!opts || typeof opts !== 'object') return 'unknown';
  const host = opts.hostname ?? opts.host ?? 'localhost';
  return `${opts.protocol ?? 'http:'}//${host}${opts.port ? `:${opts.port}` : ''}${opts.path ?? '/'}`;
}

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    mod[name] = (...args) => {
      throw blocked(describeRequest(args));
    };
  }
}

/** TCP and TLS sockets; local IPC over named pipes or unix sockets stays allowed. */
function guardSocket(mod, name) {
  const original = mod[name];
  mod[name] = (...args) => {
    const [first, second] = args;
    const opts = first && typeof first === 'object' ? first : null;
    const isPipe =
      (opts && typeof opts.path === 'string') ||
      (typeof first === 'string' && Number.isNaN(Number(first)));
    if (isPipe) return original.apply(mod, args);
    const port = opts ? opts.port : first;
    const host = opts
      ? (opts.host ?? 'localhost')
      : typeof second === 'string'
        ? second
        : 'localhost';
    throw blocked(`tcp://${host}:${port}`);
  };
}
guardSocket(net, 'connect');
guardSocket(net, 'createConnection');
guardSocket(tls, 'connect');

globalThis.fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(blocked(url));
};

syncBuiltinESMExports();
