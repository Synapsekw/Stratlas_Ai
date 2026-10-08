#!/usr/bin/env node
/* eslint-disable no-console -- release script output */
// Launches the packaged app (dist/win-unpacked) with an isolated, off-screen profile and
// QUADRION_SMOKE=1: it must load its UI and exit 0 within the time limit. A crash dialog keeps
// the process alive, so a timeout is a failure too. Run from apps/desktop after packaging.
//
// Local detection (BLD-10): onnxruntime-node's binaries must be in app.asar.unpacked, and with
// QUADRION_SMOKE_REPORT the app asks for the runtime from its window (inference:models, as
// Settings does) before it exits and writes the answer there: the runtime must load, report a
// version and offer the CPU provider. Not required on an Intel Mac (arm64 binary only).
//
// Content Security Policy: the packaged window loads from file://, where main's CSP header never
// applies; the report says what policy the page carries (its <meta>) and what eval('1') did
// there. The policy must be the app's and eval must be refused (csp-probe.mjs).
//
// The Globe (M10): the app opens it from its window and waits for its first tiles; CesiumJS's
// workers and its WebAssembly decoders load from inside app.asar over file://, which only the
// packaged app does. No worker or wasm failure, page error or CSP violation (globe-probe.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cspProbeProblem } from './csp-probe.mjs';
import { describeGlobe, globeProbeProblem } from './globe-probe.mjs';
import {
  describeOnnx,
  findPackagedApp,
  missingOnnxFiles,
  onnxProbeProblem,
  onnxRequired,
} from './onnx-probe.mjs';

const found = findPackagedApp();
if (!found) {
  console.log('Smoke check skipped: no unpacked app found (store-only build).');
  process.exit(0);
}
const exe = found.exe;
// macOS: SMOKE_ARCH=x86_64 runs the Intel slice of a universal app under Rosetta.
const arch = process.platform === 'darwin' ? process.env.SMOKE_ARCH : undefined;
const onnxNeeded = onnxRequired(found.platform, arch ?? process.arch);

const problems = [];
const missing = missingOnnxFiles(found.resources, found.platform, found.arch);
if (missing.length) {
  problems.push(
    `onnxruntime files are missing from ${found.resources}:\n${missing.map((m) => `    ${m}`).join('\n')}`,
  );
}

const userData = mkdtempSync(join(tmpdir(), 'quadrion-smoke-'));
const reportPath = join(userData, 'smoke-report.json');
const env = {
  ...process.env,
  QUADRION_SMOKE: '1',
  QUADRION_SMOKE_REPORT: reportPath,
  QUADRION_USER_DATA: userData,
  // a device key made by the smoke run stays in its throwaway userData, not the OS vault
  QUADRION_TEST_VAULT: '1',
  QUADRION_DATA: join(userData, 'data'),
};
const child = arch
  ? spawn('arch', [`-${arch}`, exe], { env, stdio: 'ignore' })
  : spawn(exe, [], { env, stdio: 'ignore' });
// The UI load, the runtime probe (the app waits at most 30 s for it) and the Globe (at most 60 s).
const LIMIT_S = 150;
const limit = setTimeout(() => {
  console.error(
    `Smoke check failed: ${exe} did not finish loading within ${LIMIT_S} s (crash dialog or hang).`,
  );
  child.kill();
  process.exit(1);
}, LIMIT_S * 1000);

function readReport() {
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

child.on('exit', (code) => {
  clearTimeout(limit);
  if (code !== 0) {
    console.error(`Smoke check failed: ${exe} exited with code ${code}.`);
    process.exit(1);
  }
  console.log(`Smoke check: ${exe} started and loaded its UI.`);
  const report = readReport();
  const onnx = onnxProbeProblem(report);
  if (onnx === null) console.log(`Smoke check: ${describeOnnx(report)}.`);
  else if (onnxNeeded) problems.push(`local detection: ${onnx}`);
  else console.log(`Smoke check: local detection not checked on this architecture (${onnx})`);
  const csp = cspProbeProblem(report);
  if (csp === null) console.log(`Smoke check: the window refuses eval (${report.csp.eval}).`);
  else problems.push(`content security policy: ${csp}`);
  const globe = globeProbeProblem(report);
  if (globe === null) console.log(`Smoke check: ${describeGlobe(report)}.`);
  else problems.push(`globe: ${globe}`);
  if (problems.length) {
    console.error('Smoke check failed:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Smoke check passed.');
  process.exit(0);
});
