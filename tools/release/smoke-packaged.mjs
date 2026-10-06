#!/usr/bin/env node
/* eslint-disable no-console -- release script output */
// Launches the packaged app (dist/win-unpacked) with an isolated, off-screen profile and
// STRATLAS_SMOKE=1: it must load its UI and exit 0 within the time limit. A crash dialog keeps
// the process alive, so a timeout is a failure too. Run from apps/desktop after packaging.
//
// Local detection (BLD-10): onnxruntime-node's binaries must be in app.asar.unpacked, and with
// STRATLAS_SMOKE_REPORT the app asks for the runtime from its window (inference:models, as
// Settings does) before it exits and writes the answer there: the runtime must load, report a
// version and offer the CPU provider. Not required on an Intel Mac (arm64 binary only).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const userData = mkdtempSync(join(tmpdir(), 'stratlas-smoke-'));
const reportPath = join(userData, 'smoke-report.json');
const env = {
  ...process.env,
  STRATLAS_SMOKE: '1',
  STRATLAS_SMOKE_REPORT: reportPath,
  STRATLAS_USER_DATA: userData,
  STRATLAS_DATA: join(userData, 'data'),
};
const child = arch
  ? spawn('arch', [`-${arch}`, exe], { env, stdio: 'ignore' })
  : spawn(exe, [], { env, stdio: 'ignore' });
// The UI load plus the runtime probe (the app waits at most 30 s for it).
const limit = setTimeout(() => {
  console.error(
    `Smoke check failed: ${exe} did not finish loading within 90 s (crash dialog or hang).`,
  );
  child.kill();
  process.exit(1);
}, 90_000);

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
  if (problems.length) {
    console.error('Smoke check failed:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Smoke check passed.');
  process.exit(0);
});
