// A throwaway "public" directory for the static-file tests, next to things that must never be
// served from it: a file outside it, a private subdirectory, dotfiles and symlinks that escape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OVERSIZED_FILE_BYTES = 2 * 1024 * 1024 + 1;

const PUBLIC_FILE_NAMES = [
  'index.html',
  'app.js',
  'data.js',
  'owner.html',
  'owner.js',
  'tv.html',
  'styles.css',
  'model.js',
  'mark.svg',
  '.hidden.js',
  'notes.txt',
  'data.json',
];

// Laid out like the real public/ folder (one folder per surface), for the demo server tests.
const SURFACE_FILE_NAMES = [
  'demo/demo.html',
  'demo/demo.js',
  'owner/owner.html',
  'owner/owner.js',
  'tv/tv.html',
  'shared/styles.css',
  'shared/format.js',
];

// Request targets that must never return file content from the fixture directory.
export const ATTACK_PATHS = [
  '/link.js',
  '/linked-dir/secret.js',
  '/.hidden.js',
  '/.private/x.js',
  '/notes.txt',
  '/data.json',
  '/huge.js',
  '/folder.js',
  '/../outside.js',
  '/%2e%2e/outside.js',
  '/..%2foutside.js',
  '/%00.js',
  '/a%5c..%5cmodel.js',
  '/a\\b.js',
  '//model.js',
  '/model.js/',
  '/./model.js',
  '/%2e/model.js',
  '/ok/../model.js',
];

/** Creates the directory and removes it again when the test (or suite) `context` finishes. */
export function makePublicDirectory(context) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'metrictv-public-'));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const publicDir = path.join(parent, 'public');
  fs.mkdirSync(publicDir);
  for (const name of [...PUBLIC_FILE_NAMES, ...SURFACE_FILE_NAMES]) {
    fs.mkdirSync(path.dirname(path.join(publicDir, name)), { recursive: true });
    fs.writeFileSync(path.join(publicDir, name), `// ${name}`);
  }
  fs.writeFileSync(path.join(publicDir, 'huge.js'), '');
  fs.truncateSync(path.join(publicDir, 'huge.js'), OVERSIZED_FILE_BYTES);
  fs.mkdirSync(path.join(publicDir, 'folder.js'));

  fs.writeFileSync(path.join(parent, 'outside.js'), '// OUTSIDE');
  fs.mkdirSync(path.join(parent, 'outside-dir'));
  fs.writeFileSync(path.join(parent, 'outside-dir', 'secret.js'), '// OUTSIDE');
  fs.symlinkSync(path.join(parent, 'outside.js'), path.join(publicDir, 'link.js'));
  fs.symlinkSync(path.join(parent, 'outside-dir'), path.join(publicDir, 'linked-dir'));
  // A symlink that stays inside the root is fine.
  fs.symlinkSync(path.join(publicDir, 'model.js'), path.join(publicDir, 'alias.js'));
  fs.mkdirSync(path.join(publicDir, '.private'));
  fs.writeFileSync(path.join(publicDir, '.private', 'x.js'), '// private');
  return publicDir;
}
