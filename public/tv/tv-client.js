// Browser API for the TV page. Same-origin requests only; the challenge and display credentials
// live in HttpOnly cookies the page cannot read, and nothing is put in browser storage.
import { sendRequest } from '../shared/api-client.js';

const TV_CHALLENGE_URL = '/api/tv/challenge';
const TV_PAIRING_URL = '/api/tv/pairing';
const TV_EXCHANGE_URL = '/api/tv/pairing/exchange';
const DISPLAY_URL = '/api/display';

const DEFAULT_POLL_MS = 10000;
const MIN_POLL_MS = 5000;
const MAX_POLL_MS = 5 * 60 * 1000;

/** Asks for a new pairing code; any earlier challenge of this browser is replaced. */
export function createChallenge(fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: TV_CHALLENGE_URL, body: {} });
}

/** State of this browser's own challenge: 'pending' or 'approved'. */
export function loadPairing(fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: TV_PAIRING_URL, method: 'GET' });
}

/** Trades an approved challenge for the display session cookie (works once). */
export function exchangePairing(fetchImpl = fetch) {
  return sendRequest({ fetchImpl, url: TV_EXCHANGE_URL, body: {} });
}

/** Resolves to {status:'paired', display} | {status:'unpaired'} | {status:'error', error}. */
export async function loadDisplay(fetchImpl = fetch) {
  const result = await sendRequest({ fetchImpl, url: DISPLAY_URL, method: 'GET' });
  if (result.status === 401) return { status: 'unpaired' };
  if (!result.ok) return { status: 'error', error: result.error };
  return { status: 'paired', display: result.data };
}

/**
 * How long a paired TV waits before asking for the board again. The server names the pace in its
 * answer, so a whole fleet can be slowed down from one place instead of with new page code on
 * every screen. A missing or unusable pace means the default; a usable one is held within bounds.
 */
export function pollDelayMs(display) {
  const seconds = display ? display.pollSeconds : undefined;
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, seconds * 1000));
}

/**
 * True when the server reports page code newer than the version this page started with.
 * A missing or malformed version never triggers a reload.
 */
export function isNewAppVersion(loadedVersion, display) {
  const reported = display ? display.appVersion : undefined;
  if (typeof reported !== 'string' || reported === '') return false;
  return loadedVersion !== null && reported !== loadedVersion;
}
