// Pure board view model for a Shopify snapshot, shared by the owner dashboard and the paired TV.
// No fetching and no globals: the TV loads this module on old browsers, so it must stay free of
// newer built-ins such as Object.hasOwn, String.prototype.replaceAll and AbortSignal.timeout.
import { normaliseStore, money, formatTime, formatDateTime } from './format.js';
import { safeShopifyAdminUrl } from './ui.js';
import { BOARD_PERIOD_OPTIONS, PERIODS } from './periods.js';

const STALE_AFTER_MS = 5 * 60 * 1000;

/** "FULFILLED" or "PARTIALLY_PAID" to "Fulfilled" or "Partially paid". */
export function humanizeStatus(value) {
  return String(value)
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (first) => first.toUpperCase());
}

/** "2026-10-14 to 2026-10-20" to "14 Oct to 20 Oct 2026". Unknown formats are shown unchanged. */
export function formatPeriodLabel(label) {
  const dates = label.split(' to ');
  if (!dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))) return label;
  for (const date of dates) {
    const instant = new Date(`${date}T12:00:00Z`);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
      return label;
    }
  }
  return dates
    .map((date, index) => {
      const isLast = index === dates.length - 1;
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        ...(isLast ? { year: 'numeric' } : {}),
      }).format(new Date(`${date}T12:00:00Z`));
    })
    .join(' to ');
}

/** True when the last refresh failed, the server's sync is unhealthy, or the data is over five minutes old. */
export function isSnapshotStale(snapshot, unavailableMessage, now) {
  const ageMs = now - Date.parse(snapshot.fetchedAt);
  return Boolean(unavailableMessage) || snapshot.sync.state !== 'ok' || !(ageMs <= STALE_AFTER_MS);
}

/** Warning text for the banner, or '' when everything is fresh and complete. */
export function buildSyncWarning(snapshot, unavailableMessage, now) {
  const messages = [];
  if (isSnapshotStale(snapshot, unavailableMessage, now)) {
    messages.push(
      'Connection interrupted. These are the last successful figures, not current data.',
    );
  }
  if (!snapshot.coverage.ordersComplete || !snapshot.coverage.inventoryComplete) {
    messages.push('Data is incomplete. Totals and alerts may be understated.');
  }
  return messages.join(' ');
}

function buildFootnoteStatus(snapshot, unavailableMessage, now) {
  if (unavailableMessage) return { tone: 'amber', text: 'Connection interrupted' };
  const time = formatTime(snapshot.fetchedAt, snapshot.shop.timeZone);
  return isSnapshotStale(snapshot, unavailableMessage, now)
    ? { tone: 'amber', text: `Last snapshot ${time}` }
    : { tone: '', text: `Updated ${time}` };
}

// The TV shows four columns so they stay readable from across a room; payment is owner detail.
function buildOrderColumns(compact) {
  if (compact) {
    return [
      { label: 'Order' },
      { label: 'Placed' },
      { label: 'Status' },
      { label: 'Value', alignRight: true },
    ];
  }
  return [
    { label: 'Order' },
    { label: 'Placed' },
    { label: 'Payment' },
    { label: 'Fulfillment' },
    { label: 'Value', alignRight: true },
  ];
}

function buildOrderRow(order, { currency, timeZone, storeDomain, compact }) {
  const numberCell = {
    text: order.number,
    kind: 'id',
    href: safeShopifyAdminUrl(order.url, storeDomain),
  };
  const placedCell = { text: formatDateTime(order.createdAt, timeZone), kind: 'muted' };
  const fulfillmentCell = {
    text: humanizeStatus(order.fulfillmentStatus),
    kind: 'status',
    fulfilled: order.fulfillmentStatus === 'FULFILLED',
  };
  const valueCell = {
    text: money(order.amountCents, false, currency),
    kind: 'amount',
    alignRight: true,
  };
  if (compact) return [numberCell, placedCell, fulfillmentCell, valueCell];
  const paymentCell = { text: humanizeStatus(order.paymentStatus) };
  return [numberCell, placedCell, paymentCell, fulfillmentCell, valueCell];
}

function buildOrders(snapshot, compact) {
  const { currency, timeZone } = snapshot.shop;
  const storeDomain = normaliseStore(snapshot.shop.domain) ?? '';
  return {
    title: 'Latest orders',
    note: `Last ${snapshot.coverage.historyDays} days`,
    emptyText: 'No non-cancelled, non-test orders in the available history.',
    columns: buildOrderColumns(compact),
    rows: snapshot.recentOrders.map((order) =>
      buildOrderRow(order, { currency, timeZone, storeDomain, compact }),
    ),
  };
}

function buildAttention(snapshot) {
  const storeDomain = normaliseStore(snapshot.shop.domain) ?? '';
  return {
    title: 'Needs attention',
    emptyText: 'No overdue orders or low-stock alerts in the available data.',
    items: snapshot.attention.map((item) => {
      const href = item.url ? safeShopifyAdminUrl(item.url, storeDomain) : '';
      return {
        title: item.title,
        description: item.description,
        tone: 'amber',
        action: href ? { type: 'link', href, label: 'View in Shopify' } : undefined,
      };
    }),
  };
}

function buildChartModel(snapshot, period, currency) {
  const selectedSeries = snapshot.charts[period];
  const config = PERIODS[period].chart;
  const toPoint = (point) => ({ label: point.label, value: point.valueCents });
  return {
    title: config.title,
    ariaLabel: config.ariaLabel,
    legend: config.legend,
    current: selectedSeries.current.map(toPoint),
    previous: selectedSeries.previous.map(toPoint),
    currency,
    axisStep: 100,
    plotStart: 62,
    dotRadius: config.dotRadius,
    emptyText: 'No history available.',
  };
}

/**
 * Builds the shared board view model from a server snapshot. Order value, not net sales.
 * `compact` drops the payment column from latest orders for the TV.
 */
export function buildStoreBoardModel({
  snapshot,
  period,
  unavailableMessage,
  now,
  compact = false,
}) {
  const { currency, timeZone } = snapshot.shop;
  const selected = snapshot.periods[period];
  const { current, previous } = selected;
  const toPoint = (day) => ({ label: day.label, value: day.valueCents });
  const formatCents = (cents) => money(cents, false, currency);
  const warning = buildSyncWarning(snapshot, unavailableMessage, now);
  const days = snapshot.coverage.historyDays;

  return {
    title: snapshot.shop.name,
    storeDomain: snapshot.shop.domain,
    subtitle: formatPeriodLabel(selected.label),
    periodOptions: BOARD_PERIOD_OPTIONS,
    selectedPeriod: period,
    banner: warning ? { message: warning } : null,
    changeStyle: 'signs',
    metrics: [
      {
        label: 'Order value',
        value: formatCents(current.valueCents),
        help: { action: 'definition', label: 'How order value is defined' },
        change: { current: current.valueCents, previous: previous.valueCents },
      },
      {
        label: 'Orders',
        value: String(current.orders),
        change: { current: current.orders, previous: previous.orders },
      },
      {
        label: 'Average order',
        value: formatCents(current.averageCents),
        change: { current: current.averageCents, previous: previous.averageCents },
      },
      {
        label: 'To fulfill',
        value: String(snapshot.backlog.count),
        note: `${snapshot.backlog.overdueCount} over 24h · Last ${days} days`,
      },
    ],
    comparisonText: selected.comparisonLabel,
    chart: buildChartModel(snapshot, period, currency),
    attention: buildAttention(snapshot),
    orders: buildOrders(snapshot, compact),
    status: buildFootnoteStatus(snapshot, unavailableMessage, now),
    scope: `${currency} · ${timeZone}`,
  };
}
