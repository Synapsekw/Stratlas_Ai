// E2E stand-in for ODM's Inno setup: honours /DIR=, writes what the install check looks for, takes
// a second so the card shows "Installing", and exits 0 (or FAKE_SETUP_EXIT).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv.find((a) => a.startsWith('/DIR='))?.slice(5);
if (!dir) process.exit(1);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'run.bat'),
  '@echo off\r\necho usage: run [options] ^<dataset name^>\r\nexit /b 0\r\n',
);
writeFileSync(join(dir, 'VERSION'), '3.6.2');
// every other REQUIRED_FILES entry (C4: winrun.bat, win32env.bat, venv\Scripts\python.exe), as empty files
for (const rel of (process.env.FAKE_SETUP_FILES ?? '').split(';').filter(Boolean)) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), '');
}
await new Promise((r) => setTimeout(r, 1000));
process.exit(Number(process.env.FAKE_SETUP_EXIT ?? 0));
