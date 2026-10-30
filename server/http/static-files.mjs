// Small shared helpers for serving the public directory safely. Not a web framework:
// each server still owns its routes, headers and responses.
import fs from 'node:fs/promises';
import path from 'node:path';

export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
});

const MAX_STATIC_FILE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

export function createSecurityHeaders({ allowApiRequests = false } = {}) {
  const connectSource = allowApiRequests ? "'self'" : "'none'";
  return Object.freeze({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      `img-src 'self' data:; connect-src ${connectSource}; object-src 'none'; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
}

export function isReadMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

// All values of a header as sent on the wire. req.headers merges duplicates, which hides them.
export function rawHeaderValues(rawHeaders, headerName) {
  const wanted = headerName.toLowerCase();
  const values = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === wanted) values.push(rawHeaders[index + 1]);
  }
  return values;
}

// Returns the single value of a header, or null when it is missing, repeated or comma-joined.
export function singleHeaderValue(rawHeaders, headerName) {
  const values = rawHeaderValues(rawHeaders, headerName);
  if (values.length !== 1 || values[0].includes(',')) return null;
  return values[0].trim();
}

// Turns a request target into a decoded pathname.
// Result: { pathname } or { rejection: 'bad_request' | 'not_found' }.
export function parseRequestPath(requestUrl) {
  if (
    typeof requestUrl !== 'string' ||
    !requestUrl.startsWith('/') ||
    requestUrl.startsWith('//')
  ) {
    return { rejection: 'bad_request' };
  }
  const rawPath = requestUrl.split(/[?#]/, 1)[0];
  // Checked before decoding: the URL parser would turn "\" into "/".
  if (FORBIDDEN_PATH_CHARACTERS.test(rawPath)) return { rejection: 'not_found' };
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return { rejection: 'bad_request' };
  }
  if (FORBIDDEN_PATH_CHARACTERS.test(pathname)) return { rejection: 'not_found' };
  return { pathname };
}

function isInside(directory, candidate) {
  return candidate.startsWith(directory + path.sep);
}

// Finds a servable file for a decoded pathname, or null. Applies, in order: entry-file
// blocklist, no empty/dot segments, no dotfiles, extension allowlist, lexical containment,
// and containment of the symlink-resolved path inside the resolved public root.
// options: { indexFile, blockedPaths: Set<string> }
export async function findPublicFile(publicDir, pathname, { indexFile, blockedPaths = new Set() }) {
  const requestedPath = pathname === '/' ? `/${indexFile}` : pathname;
  if (blockedPaths.has(requestedPath)) return null;
  const segments = requestedPath.split('/').slice(1);
  for (const segment of segments) {
    if (segment === '' || segment.startsWith('.')) return null;
  }
  const extension = path.extname(requestedPath).toLowerCase();
  if (!Object.hasOwn(CONTENT_TYPES, extension)) return null;

  try {
    const realRoot = await fs.realpath(publicDir);
    const candidate = path.resolve(realRoot, ...segments);
    if (!isInside(realRoot, candidate)) return null;
    const realFile = await fs.realpath(candidate);
    if (!isInside(realRoot, realFile)) return null;
    const resolvedSegments = path.relative(realRoot, realFile).split(path.sep);
    if (resolvedSegments.some((segment) => segment.startsWith('.'))) return null;
    if (blockedPaths.has(`/${resolvedSegments.join('/')}`)) return null;
    const resolvedExtension = path.extname(realFile).toLowerCase();
    if (!Object.hasOwn(CONTENT_TYPES, resolvedExtension)) return null;
    const stats = await fs.stat(realFile);
    if (!stats.isFile() || stats.size > MAX_STATIC_FILE_BYTES) return null;
    return { filePath: realFile, contentType: CONTENT_TYPES[resolvedExtension] };
  } catch {
    return null;
  }
}

// Bounds slow or oversized requests. Values are well above anything the dashboard sends.
export const SERVER_OPTIONS = Object.freeze({ maxHeaderSize: 16 * 1024 });

export function applyServerLimits(server) {
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  return server;
}
