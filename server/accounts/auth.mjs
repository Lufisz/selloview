// Better Auth configured as an email-code, single-purpose login: invite-only by default, with
// capacity-capped self-service registration only when the operator opts in.
//
// Better Auth owns users, sessions, one-time codes and rate limits. This file only narrows it:
// no public sign-up, no password/social/linking/email-change features, and a short allowlist of
// the endpoints a browser may reach.
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import { logEvent } from '../log.mjs';
import { closedRegistration } from './registration.mjs';

export const AUTH_BASE_PATH = '/api/auth';
export const SEND_CODE_PATH = '/email-otp/send-verification-otp';
export const SIGN_IN_PATH = '/sign-in/email-otp';
export const SIGN_OUT_PATH = '/sign-out';
// Set by this server from the socket (or a configured trusted proxy header), never by browsers.
export const CLIENT_IP_HEADER = 'x-selloview-client-ip';

// Paths a browser-originated request may reach inside Better Auth (/get-session is used only by
// this server's own session lookup, never forwarded from the network).
const BROWSER_REACHABLE_PATHS = new Set([SEND_CODE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH]);

// Defence in depth behind the allowlist above: endpoints that would create accounts, link
// identities, change emails or manage other sessions stay off even if the allowlist regresses.
const DISABLED_PATHS = Object.freeze([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/social',
  '/sign-in/anonymous',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/callback/:id',
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  '/update-user',
  '/delete-user',
  '/change-email',
  '/change-password',
  '/set-password',
  '/reset-password',
  '/request-password-reset',
  '/forget-password',
  '/send-verification-email',
  '/verify-email',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/email-otp/verify-email',
  '/email-otp/check-verification-otp',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
  '/forget-password/email-otp',
]);

// A code is emailed after the reply is sent. Waiting for the provider would make a request for an
// invited address slower than one for any other address, and answer it with an error while the
// provider fails, which tells a stranger who is invited. A failed send is logged instead, with its
// error code and never the address or the code.
// ceiling: sends are not queued; the rate limit (3 requests a minute per visitor) and the
// transport's 8 s timeout bound how many are in flight,
// upgrade: queue them if an outage piles them up
async function deliverCode(mailTransport, recipient, code) {
  try {
    await mailTransport.sendSignInCode({ recipient, code });
  } catch (error) {
    logEvent('code_delivery_failed', {
      code: error?.code ?? 'unknown',
      error: error?.name ?? 'Error',
    });
  }
}

const CODE_LENGTH = 6;
const CODE_LIFETIME_SECONDS = 5 * 60;
const CODE_ATTEMPTS = 3;
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_RULES = Object.freeze({
  [SEND_CODE_PATH]: { window: RATE_LIMIT_WINDOW_SECONDS, max: 3 },
  [SIGN_IN_PATH]: { window: RATE_LIMIT_WINDOW_SECONDS, max: 6 },
  [SIGN_OUT_PATH]: { window: RATE_LIMIT_WINDOW_SECONDS, max: 20 },
});

function restrictBrowserEndpoints() {
  return createAuthMiddleware(async (context) => {
    if (!context.request) return;
    if (BROWSER_REACHABLE_PATHS.has(context.path)) return;
    throw context.error('NOT_FOUND', { message: 'Not found' });
  });
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {string} options.secret  Operator-provided, at least 32 characters.
 * @param {string} options.origin  Exact public origin, e.g. https://selloview.example.com.
 * @param {{sendSignInCode: Function}} options.mailTransport
 * @param {boolean} [options.allowUserCreation]  True only for the operator invite command.
 * @param {import('./registration.mjs').closedRegistration} [options.registration]
 *   Opt-in self-service policy; the default admits nobody but invited emails.
 */
export function createAuthOptions({
  database,
  secret,
  origin,
  mailTransport,
  allowUserCreation = false,
  registration = closedRegistration,
}) {
  const isHttps = new URL(origin).protocol === 'https:';
  return {
    appName: 'Selloview',
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret,
    database,
    trustedOrigins: [origin],
    disabledPaths: [...DISABLED_PATHS],
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: 30,
      customRules: RATE_LIMIT_RULES,
    },
    advanced: {
      // Explicit: Better Auth would otherwise skip its origin check when NODE_ENV is "test".
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: isHttps,
      // Not renamed with the rest of "beta": it is in every owner's browser as the session cookie
      // name, so changing it would sign everybody out.
      cookiePrefix: 'metrictv_beta',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: isHttps },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    databaseHooks: {
      user: {
        create: {
          // Accounts exist because an operator invited that exact email, or, only when the
          // operator opted in, because an emailed code proved the address and room is left.
          before: async (user) => {
            if (allowUserCreation) return undefined;
            const isVerified = user.emailVerified === true;
            return registration.enabled && isVerified && registration.hasRoom() ? undefined : false;
          },
        },
      },
    },
    hooks: { before: restrictBrowserEndpoints() },
    plugins: [
      emailOTP({
        disableSignUp: !registration.enabled,
        otpLength: CODE_LENGTH,
        expiresIn: CODE_LIFETIME_SECONDS,
        allowedAttempts: CODE_ATTEMPTS,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return;
          // Not awaited on purpose, see deliverCode.
          deliverCode(mailTransport, email, otp);
        },
      }),
    ],
  };
}

export function createAuth(options) {
  return betterAuth(createAuthOptions(options));
}

/**
 * Deletes what can no longer be used: expired sessions and sign-in codes, and rate-limit rows
 * older than their window (Better Auth starts a fresh count for those anyway).
 */
export function purgeExpiredSignInRows(database, nowMs = Date.now()) {
  // Better Auth stores expiry times as ISO text, which sorts like the instants it names.
  const nowIso = new Date(nowMs).toISOString();
  database.prepare('DELETE FROM session WHERE expiresAt <= ?').run(nowIso);
  database.prepare('DELETE FROM verification WHERE expiresAt <= ?').run(nowIso);
  const windowStart = nowMs - RATE_LIMIT_WINDOW_SECONDS * 1000;
  database.prepare('DELETE FROM rateLimit WHERE lastRequest <= ?').run(windowStart);
}
