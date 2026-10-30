// Fingerprint of the page files the app serves. A paired TV receives it with every display
// poll and reloads itself when it changes, so a TV left running never keeps old page code.
//
// Built from file names, sizes and modification times rather than contents: cheap enough to
// recheck often, and any deployment changes at least one of them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RECHECK_MS = 30 * 1000;

/**
 * @param {string} publicDir   directory the files are served from
 * @param {Iterable<string>} filePaths  served paths such as '/tv/tv.js'
 * @returns {(nowMs?: number) => string} current version, recomputed at most every 30 seconds
 */
export function createAppVersion(publicDir, filePaths) {
  const sortedPaths = [...filePaths].sort();
  let version = '';
  let computedAt = -Infinity;

  function compute() {
    const hash = crypto.createHash('sha256');
    for (const filePath of sortedPaths) {
      try {
        const stats = fs.statSync(path.join(publicDir, filePath));
        hash.update(`${filePath}:${stats.size}:${stats.mtimeMs}\n`);
      } catch {
        hash.update(`${filePath}:missing\n`);
      }
    }
    return hash.digest('base64url').slice(0, 16);
  }

  return function currentVersion(nowMs = Date.now()) {
    if (nowMs - computedAt >= RECHECK_MS) {
      version = compute();
      computedAt = nowMs;
    }
    return version;
  };
}
