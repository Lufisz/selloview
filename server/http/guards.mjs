// Request guards shared by the app routes: exact-origin checks, bounded JSON bodies, JSON
// responses. Duplicate or comma-joined security headers are rejected, never merged.
import { CodedError } from '../errors.mjs';
import { createSecurityHeaders, rawHeaderValues, singleHeaderValue } from './static-files.mjs';

const MAX_JSON_BODY_BYTES = 2048;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin']);

/** Rejection with the HTTP status and stable error code to return. */
export class RequestRejection extends CodedError {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export function createResponseHeaders(origin) {
  const headers = { ...createSecurityHeaders({ allowApiRequests: true }) };
  if (new URL(origin).protocol === 'https:') {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }
  return Object.freeze(headers);
}

/** Host must be the configured public host, which blocks DNS-rebinding style access. */
export function assertExpectedHost(request, origin) {
  const host = singleHeaderValue(request.rawHeaders, 'host');
  if (host !== new URL(origin).host) throw new RequestRejection(400, 'bad_host');
}

/** State-changing requests: exact Origin, not cross-site, and a JSON content type. */
export function assertSameOriginJson(request, origin) {
  const suppliedOrigin = singleHeaderValue(request.rawHeaders, 'origin');
  if (suppliedOrigin !== origin) throw new RequestRejection(403, 'invalid_origin');

  const fetchSite = singleHeaderValue(request.rawHeaders, 'sec-fetch-site');
  const fetchSiteSent = request.rawHeaders.some((name) => name.toLowerCase() === 'sec-fetch-site');
  if (fetchSiteSent && !SAME_ORIGIN_FETCH_SITES.has(fetchSite)) {
    throw new RequestRejection(403, 'invalid_origin');
  }

  const contentType = singleHeaderValue(request.rawHeaders, 'content-type');
  if (contentType === null || !JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new RequestRejection(415, 'unsupported_media_type');
  }
}

async function readBoundedBody(request) {
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new RequestRejection(413, 'body_too_large');
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) throw new RequestRejection(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a JSON object body whose keys are exactly `allowedKeys` (all required). */
export async function readJsonObject(request, allowedKeys) {
  const text = await readBoundedBody(request);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestRejection(400, 'invalid_json');
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const keys = isObject ? Object.keys(parsed) : [];
  const hasExactKeys =
    keys.length === allowedKeys.length && allowedKeys.every((key) => Object.hasOwn(parsed, key));
  if (!hasExactKeys) throw new RequestRejection(400, 'invalid_request');
  return parsed;
}

export function sendJson(response, headers, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9._~-]+$/;
// The official Shopify SDK signs its state cookie with a padded base64 signature.
export const SIGNED_COOKIE_VALUE_PATTERN = /^[A-Za-z0-9+/=_.~-]+$/;

/** Value of one named cookie, or null when missing, repeated or sent in several headers. */
export function readCookie(request, name, valuePattern = COOKIE_VALUE_PATTERN) {
  // Commas are legal inside other cookies' values, so only the header count is checked here.
  const headers = rawHeaderValues(request.rawHeaders, 'cookie');
  if (headers.length !== 1) return null;
  const values = [];
  for (const part of headers[0].split(';')) {
    const separator = part.indexOf('=');
    if (part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 && valuePattern.test(values[0]) ? values[0] : null;
}

/**
 * Set-Cookie text for a host-only, HttpOnly cookie; an empty value clears it. SameSite=Strict
 * unless the cookie has to come back with a cross-site navigation (the Shopify callback).
 */
export function buildCookie({
  name,
  value,
  maxAgeSeconds,
  secure,
  path = '/',
  sameSite = 'Strict',
}) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  parts.push(value === '' ? 'Max-Age=0' : `Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
