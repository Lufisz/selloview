// The rules for private data on disk, in one place: the database file and the Shopify grant files
// must be owned by the server's user, closed to group and others, and kept outside the project,
// whose public/ folder is served.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True for an absolute path that is already normalized and holds no NUL byte. */
export function isCleanAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

/** True when `child` is `parent` itself or below it. Both must be clean absolute paths. */
export function isInside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

/** True when a file or directory (from fs.stat) is ours alone: no access for group or others. */
export function isPrivate(stats) {
  const userId = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const isOwnedByUs = userId === undefined || stats.uid === userId;
  return isOwnedByUs && (stats.mode & GROUP_AND_OTHER_BITS) === 0;
}
