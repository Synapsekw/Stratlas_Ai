/* eslint-disable no-console -- the command line prints */
import { runCli } from './cli';

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  print: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
});
if (code !== 0) process.exitCode = code;
