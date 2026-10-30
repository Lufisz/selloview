// Validation of a server snapshot before any renderer may use it. Pure functions, no fetching,
// no built-ins newer than ES2019: the paired TV imports this module.
import { normaliseStore } from './model.js';

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/** The paired TV gets no store domain at all; the owner's snapshot must carry a valid one. */
function hasAcceptableDomain(domain, requireStoreDomain) {
  if (!requireStoreDomain && domain === undefined) return true;
  return typeof domain === 'string' && Boolean(normaliseStore(domain));
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function hasPeriod(period) {
  return (
    Boolean(period) &&
    hasText(period.label) &&
    hasText(period.comparisonLabel) &&
    hasTotals(period.current) &&
    hasTotals(period.previous)
  );
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value) {
  return hasText(value) && Number.isFinite(Date.parse(value));
}

function hasTotals(totals) {
  return (
    Boolean(totals) &&
    ['valueCents', 'orders', 'averageCents'].every((field) => isNonnegativeInteger(totals[field]))
  );
}

function hasChartSeries(points, maxPoints = 60) {
  return (
    Array.isArray(points) &&
    points.length <= maxPoints &&
    points.every(
      (point) =>
        Boolean(point) && typeof point.label === 'string' && isNonnegativeInteger(point.valueCents),
    )
  );
}

function hasAttentionItems(items) {
  return (
    Array.isArray(items) &&
    items.length <= 3 &&
    items.every(
      (item) =>
        Boolean(item) &&
        hasText(item.title) &&
        typeof item.description === 'string' &&
        (item.url === undefined || typeof item.url === 'string'),
    )
  );
}

function hasRecentOrders(orders) {
  return (
    Array.isArray(orders) &&
    orders.length <= 8 &&
    orders.every(
      (order) =>
        Boolean(order) &&
        hasText(order.number) &&
        isTimestamp(order.createdAt) &&
        isNonnegativeInteger(order.amountCents) &&
        hasText(order.paymentStatus) &&
        hasText(order.fulfillmentStatus) &&
        (order.url === undefined || typeof order.url === 'string'),
    )
  );
}

function hasCoverage(coverage) {
  return (
    Boolean(coverage) &&
    Number.isSafeInteger(coverage.historyDays) &&
    coverage.historyDays > 0 &&
    coverage.historyDays <= 400 &&
    typeof coverage.ordersComplete === 'boolean' &&
    typeof coverage.inventoryComplete === 'boolean' &&
    Array.isArray(coverage.notes) &&
    coverage.notes.every((note) => typeof note === 'string')
  );
}

/** Validate every field used by rendering before replacing a last-good snapshot. */
export function isUsableSnapshot(value, { requireStoreDomain = true } = {}) {
  if (!value || value.source !== 'shopify') return false;
  const { shop, periods, chart, backlog, coverage, sync } = value;
  return (
    Boolean(shop) &&
    hasText(shop.name) &&
    hasAcceptableDomain(shop.domain, requireStoreDomain) &&
    (shop.plan === null || typeof shop.plan === 'string') &&
    /^[A-Z]{3}$/.test(shop.currency ?? '') &&
    hasText(shop.timeZone) &&
    isValidTimeZone(shop.timeZone) &&
    hasPeriod(periods?.days60) &&
    hasPeriod(periods?.month) &&
    hasPeriod(periods?.week) &&
    hasPeriod(periods?.today) &&
    hasChartSeries(chart?.current) &&
    hasChartSeries(chart?.previous) &&
    (!value.charts ||
      (hasChartSeries(value.charts?.today?.current, 24) &&
        hasChartSeries(value.charts?.today?.previous, 24) &&
        hasChartSeries(value.charts?.week?.current, 7) &&
        hasChartSeries(value.charts?.week?.previous, 7) &&
        hasChartSeries(value.charts?.month?.current, 30) &&
        hasChartSeries(value.charts?.month?.previous, 30) &&
        hasChartSeries(value.charts?.days60?.current, 60) &&
        hasChartSeries(value.charts?.days60?.previous, 60))) &&
    hasAttentionItems(value.attention) &&
    hasRecentOrders(value.recentOrders) &&
    isNonnegativeInteger(backlog?.count) &&
    isNonnegativeInteger(backlog?.overdueCount) &&
    backlog.overdueCount <= backlog.count &&
    hasCoverage(coverage) &&
    ['ok', 'stale', 'loading', 'error'].includes(sync?.state) &&
    hasText(value.metricDefinition) &&
    isTimestamp(value.fetchedAt)
  );
}
