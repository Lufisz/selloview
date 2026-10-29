// Opt-in, capacity-capped self-service registration.
//
// Registration stays closed unless the operator sets BETA_SELF_REGISTRATION=enabled together with
// BETA_REGISTRATION_MAX_ACCOUNTS. It adds no sign-up endpoint of its own: Better Auth's existing
// email-code sign-in creates the account, and only after the emailed code was verified. This file
// decides whether that creation is allowed and bounds how much public traffic can ask for it.
import { createRateLimiter } from './rate-limiter.mjs';

const ENABLED_VALUE = 'enabled';
const MAX_CONFIGURABLE_ACCOUNTS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
// Codes for addresses that have no account yet cost real email. Bound them per client and overall.
const NEW_ADDRESS_CODES_PER_CLIENT_PER_HOUR = 5;
const NEW_ADDRESS_CODES_PER_HOUR = 60;

/** Reads the opt-in flag and the account cap. Enabling without a valid cap is a startup error. */
export function loadRegistrationConfig(env = process.env) {
  const flag = env.BETA_SELF_REGISTRATION ?? '';
  if (flag === '') return { enabled: false, maxAccounts: 0 };
  if (flag !== ENABLED_VALUE) {
    throw new Error(`BETA_SELF_REGISTRATION must be "${ENABLED_VALUE}" or unset`);
  }
  const capText = env.BETA_REGISTRATION_MAX_ACCOUNTS ?? '';
  const maxAccounts = Number(capText);
  const isValidCap =
    /^\d{1,5}$/.test(capText) && maxAccounts >= 1 && maxAccounts <= MAX_CONFIGURABLE_ACCOUNTS;
  if (!isValidCap) {
    throw new Error(
      `BETA_REGISTRATION_MAX_ACCOUNTS must be a whole number from 1 to ${MAX_CONFIGURABLE_ACCOUNTS}`,
    );
  }
  return { enabled: true, maxAccounts };
}

/** Policy used when registration is not configured: invite-only, nothing available. */
export const closedRegistration = Object.freeze({
  enabled: false,
  hasRoom: () => false,
  emailHasAccount: () => false,
  status: () => ({ enabled: false, available: false }),
  runExclusive: (operation) => operation(),
  consumeNewAddressCode: () => ({ allowed: false, retryAfterSeconds: 1 }),
});

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {{enabled: boolean, maxAccounts: number}} options.config
 */
export function createRegistrationPolicy({ database, config }) {
  if (!config.enabled) return closedRegistration;

  const countAccounts = database.prepare('SELECT COUNT(*) AS total FROM "user"');
  const findAccount = database.prepare('SELECT 1 AS found FROM "user" WHERE email = ?');
  const clientLimiter = createRateLimiter({
    limit: NEW_ADDRESS_CODES_PER_CLIENT_PER_HOUR,
    windowMs: HOUR_MS,
  });
  const overallLimiter = createRateLimiter({
    limit: NEW_ADDRESS_CODES_PER_HOUR,
    windowMs: HOUR_MS,
    maxKeys: 1,
  });

  // Verifications that may create accounts run one at a time, so the capacity check and the
  // insert cannot interleave. This process is the only writer of new accounts besides the
  // operator invite command, which is a separate short-lived process.
  let queue = Promise.resolve();

  function hasRoom() {
    return countAccounts.get().total < config.maxAccounts;
  }

  return {
    enabled: true,
    hasRoom,
    emailHasAccount: (email) => Boolean(findAccount.get(email)),
    status: () => ({ enabled: true, available: hasRoom() }),
    runExclusive(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    },
    /** Counts one code request for an address without an account; refuses over either limit. */
    consumeNewAddressCode(clientKey) {
      const client = clientLimiter.consume(clientKey);
      if (!client.allowed) return client;
      return overallLimiter.consume('all');
    },
  };
}
