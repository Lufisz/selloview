/** Own-property check that also works in older TV browsers, which lack Object.hasOwn. */
export function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

/**
 * Formats integer minor units (cents) for display.
 * Currency is always passed in: a store snapshot sets it live, the demo uses EUR.
 */
export function money(cents, compact = false, currency = 'EUR') {
  const fractionDigits = compact ? 0 : 2;
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(cents / 100);
}

/** Clock time such as "14:42" in the given IANA time zone. */
export function formatTime(isoTimestamp, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(isoTimestamp),
  );
}

/** Short date and time such as "21 Oct, 14:42" in the given IANA time zone. */
export function formatDateTime(isoTimestamp, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoTimestamp));
}

export function percentChange(current, previous) {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

export function summarise(days) {
  const revenue = days.reduce((total, day) => total + day.revenue, 0);
  const orders = days.reduce((total, day) => total + day.orders, 0);
  return { revenue, orders, averageOrder: orders ? revenue / orders : 0 };
}

export function getPeriod(days, period) {
  const count = period === 'today' ? 1 : 7;
  const currentDays = days.slice(-count);
  const previousDays = days.slice(-count * 2, -count);
  return {
    currentDays,
    previousDays,
    current: summarise(currentDays),
    previous: summarise(previousDays),
  };
}

export function normaliseStore(value) {
  const store = String(value).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(store) ? store : null;
}

export function goalProgress(revenueCents, goalEuros) {
  return goalEuros > 0 ? Math.min(100, Math.max(0, (revenueCents / (goalEuros * 100)) * 100)) : 0;
}
