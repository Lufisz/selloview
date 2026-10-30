// Browser API for the TV page. Same-origin requests only; the challenge and display credentials
// live in HttpOnly cookies the page cannot read, and nothing is put in browser storage.
import { sendRequest } from '../owner/owner-client.js';

export const TV_CHALLENGE_URL = '/api/tv/challenge';
export const TV_PAIRING_URL = '/api/tv/pairing';
export const TV_EXCHANGE_URL = '/api/tv/pairing/exchange';
export const DISPLAY_URL = '/api/display';

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
 * True when the server reports page code newer than the version this page started with.
 * A missing or malformed version never triggers a reload.
 */
export function isNewAppVersion(loadedVersion, display) {
  const reported = display ? display.appVersion : undefined;
  if (typeof reported !== 'string' || reported === '') return false;
  return loadedVersion !== null && reported !== loadedVersion;
}
