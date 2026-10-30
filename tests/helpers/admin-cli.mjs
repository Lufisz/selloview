// Runs scripts/admin.mjs as a real process, the way an operator does.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'admin.mjs',
);

/** Resolves with `{ code, stdout, stderr }`; a failing command is a result, not an exception. */
export function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ADMIN_SCRIPT, ...args],
      { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}
