// The signed-in owner of a request. Every owner route starts here: the owner is whoever the Better
// Auth session cookie names, and routes that change something also need the CSRF token bound to
// that session. No owner or workspace id is ever read from the browser.
import crypto from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { constantTimeEqual } from '../hashing.mjs';
import { singleHeaderValue } from '../http/static-files.mjs';

/**
 * CSRF token bound to one server-side session; the browser keeps it in memory only. The label is
 * part of the HMAC input, so it keeps its original value: changing it would invalidate the token of
 * every page that is open during an upgrade.
 */
function deriveCsrfToken(secret, sessionId) {
  return crypto.createHmac('sha256', secret).update(`beta-csrf\n${sessionId}`).digest('base64url');
}

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./auth.mjs').createAuth>} options.auth
 * @param {string} options.secret  The server secret the CSRF tokens are derived from. It stays here.
 * @param {(response, status, body) => void} options.reply  Sends the denials.
 */
export function createOwnerSession({ auth, secret, reply }) {
  async function lookupSession(request) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  function csrfTokenFor(sessionId) {
    return deriveCsrfToken(secret, sessionId);
  }

  function isValidCsrf(request, sessionId) {
    const supplied = singleHeaderValue(request.rawHeaders, 'x-csrf-token');
    return supplied !== null && constantTimeEqual(supplied, csrfTokenFor(sessionId));
  }

  // Resolves the signed-in owner and checks the session-bound CSRF token.
  // Returns session data, or null after having sent the denial.
  async function requireCsrfSession(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) {
      reply(response, 401, { error: 'unauthenticated' });
      return null;
    }
    if (!isValidCsrf(request, sessionData.session.id)) {
      reply(response, 403, { error: 'invalid_csrf' });
      return null;
    }
    return sessionData;
  }

  return { lookupSession, requireCsrfSession, csrfTokenFor };
}
