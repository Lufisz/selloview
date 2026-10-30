// Deletes rows that can never be used again, so the private database stays small however long the
// server runs and however many anonymous visitors have asked for a pairing code or a sign-in code.
// Every read already ignores expired rows; this only reclaims the space.
import { purgeExpiredSignInRows } from './accounts/auth.mjs';
import { logEvent } from './log.mjs';
import { purgeExpiredScreens } from './screens/screens.mjs';

// ceiling: one synchronous pass over every table, about 15 ms to scan 500,000 live rows and 0.4 s to
// delete 500,000 expired ones (measured on a laptop), upgrade: delete in batches of a few thousand
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export function purgeExpiredRows(database, nowMs = Date.now()) {
  purgeExpiredScreens(database, nowMs);
  purgeExpiredSignInRows(database, nowMs);
}

/** Purges now and then every hour. Returns a function that stops it. */
export function startHousekeeping(database) {
  function purgeAndReport() {
    try {
      purgeExpiredRows(database);
    } catch (error) {
      logEvent('housekeeping_failed', { error: error?.name ?? 'Error' });
    }
  }

  purgeAndReport();
  const timer = setInterval(purgeAndReport, PURGE_INTERVAL_MS);
  // The timer must never be the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}
