// Pure metric calculation. "Order value" = sum of currentTotalPriceSet, nothing more.
// Input is RawShopData from server/shopify/shop-data.mjs; output is the snapshot documented below.
import { HISTORY_DAYS, validateStore } from './shopify/shop-data.mjs';

/**
 * @typedef {{ valueCents: number, orders: number, averageCents: number }} PeriodTotals
 * @typedef {{ date: string, label: string, valueCents: number }} ChartPoint
 * @typedef {{ id: string, title: string, description: string, url?: string }} AttentionItem
 *
 * The /api/snapshot payload (the server adds `sync` when serving it):
 * @typedef {object} Snapshot
 * @property {'shopify'} source
 * @property {{ name: string, domain: string, currency: string, timeZone: string, plan: (string | null) }} shop
 * @property {string} fetchedAt
 * @property {{ since: string, until: string, historyDays: number, ordersComplete: boolean, inventoryComplete: boolean, notes: string[] }} coverage
 * @property {{ days60: { label: string, comparisonLabel: string, current: PeriodTotals, previous: PeriodTotals },
 *              month: { label: string, comparisonLabel: string, current: PeriodTotals, previous: PeriodTotals },
 *              week: { label: string, comparisonLabel: string, current: PeriodTotals, previous: PeriodTotals },
 *              today: { label: string, comparisonLabel: string, current: PeriodTotals, previous: PeriodTotals } }} periods
 * @property {{ current: ChartPoint[], previous: ChartPoint[] }} chart  Seven local days each.
 * @property {Array<{ number: string, createdAt: string, amountCents: number, paymentStatus: string, fulfillmentStatus: string, url?: string }>} recentOrders
 * @property {AttentionItem[]} attention  At most three.
 * @property {{ count: number, overdueCount: number }} backlog
 * @property {{ trackedVariants: number, lowCount: number }} inventory
 * @property {string} metricDefinition
 *
 * An order that passed validation: `at` is the created instant in ms, `cents` its order value.
 * @typedef {{ order: object, at: number, cents: number }} PreparedOrder
 */

export class MetricsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MetricsError';
    this.code = code;
  }
}

export const METRIC_DEFINITION =
  'Order value is the sum of Shopify currentTotalPriceSet (shop currency) for non-test, non-cancelled orders created in the period. It is not net sales, cash received or profit, and is not a reconciled Shopify sales report.';
const BACKLOG_PAYMENT_STATUSES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED']);
const BACKLOG_FULFILLMENT_STATUSES = new Set(['UNFULFILLED', 'PARTIALLY_FULFILLED']);
const LOW_STOCK_THRESHOLD = 5;
const HOUR_MS = 3600000;
// A paid order that is still unfulfilled after this long counts as overdue.
const OVERDUE_AFTER_MS = 24 * HOUR_MS;
const MAX_ATTENTION_ITEMS = 3;
const RECENT_ORDER_COUNT = 8;
const WEEK_DAYS = 7;
const THIRTY_DAYS = 30;
const SIXTY_DAYS = 60;
// Longer daily charts label the first and last day and every Nth day between; the weekly chart
// labels every day by its weekday.
const DATE_LABEL_EVERY_N_DAYS = new Map([
  [SIXTY_DAYS, 12],
  [THIRTY_DAYS, 7],
]);
const TODAY_CHART_LABEL_HOURS = new Set([0, 6, 12, 18, 23]);
const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/(\d+)$/;

// ---- money, dates and time zones ----

export function parseCents(amount) {
  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new MetricsError('bad_amount');
  }
  const [wholePart, fractionPart = ''] = amount.split('.');
  // BigInt keeps very long digit strings exact until the safe-integer check.
  const cents = BigInt(wholePart) * 100n + BigInt(fractionPart.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MetricsError('bad_amount');
  return Number(cents);
}

// Adds two cent totals; a sum beyond the safe-integer range is an error, never a rounded value.
function addCents(total, cents) {
  const sum = total + cents;
  if (!Number.isSafeInteger(sum)) throw new MetricsError('bad_amount');
  return sum;
}

export function parseInstant(text) {
  if (typeof text !== 'string') throw new MetricsError('bad_date');
  const instant = Date.parse(text);
  if (!Number.isFinite(instant)) throw new MetricsError('bad_date');
  return instant;
}

const formatterByTimeZone = new Map();

// A snapshot reads the local date of every order several times and building a formatter is slow
// (a refresh of 10,000 orders stalled the server for over a second), so each time zone's formatter
// is built once and reused.
function getFormatter(timeZone) {
  const knownFormatter = formatterByTimeZone.get(timeZone);
  if (knownFormatter) return knownFormatter;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new MetricsError('bad_timezone');
  }
  formatterByTimeZone.set(timeZone, formatter);
  return formatter;
}

function wallClockParts(instantMs, formatter) {
  const numbers = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') numbers[part.type] = Number(part.value);
  }
  return numbers;
}

export function localDate(instantMs, timeZone) {
  const { year, month, day } = wallClockParts(instantMs, getFormatter(timeZone));
  const paddedYear = String(year).padStart(4, '0');
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  return `${paddedYear}-${paddedMonth}-${paddedDay}`;
}

// Plain-date arithmetic, independent of any timezone.
export function addDays(date, dayCount) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayCount)).toISOString().slice(0, 10);
}

// Instant of local wall-clock time on a plain date (two-pass offset lookup; fine for midnight and ordinary times).
export function localToInstant(date, timeZone, hour = 0, minute = 0, second = 0) {
  const formatter = getFormatter(timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (instantMs) => {
    const parts = wallClockParts(instantMs, formatter);
    const localAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    return localAsUtc - Math.floor(instantMs / 1000) * 1000;
  };
  const firstGuess = wallClockAsUtc - offsetAt(wallClockAsUtc);
  return wallClockAsUtc - offsetAt(firstGuess);
}

function weekdayLabel(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

function formatMonthDay(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function millisecondsIntoLocalDay(instantMs, formatter) {
  const parts = wallClockParts(instantMs, formatter);
  const secondsIntoDay = (parts.hour * 60 + parts.minute) * 60 + parts.second;
  return secondsIntoDay * 1000 + new Date(instantMs).getUTCMilliseconds();
}

// ---- links ----

// Order admin link, or undefined when the id is not a Shopify Order gid or the domain is untrusted.
export function adminUrl(domain, gid) {
  const match = ORDER_GID_PATTERN.exec(String(gid));
  if (!match || !isShopifyDomain(domain)) return undefined;
  const storeHandle = domain.replace(/\.myshopify\.com$/, '');
  return `https://admin.shopify.com/store/${storeHandle}/orders/${match[1]}`;
}

function isShopifyDomain(domain) {
  try {
    validateStore(domain);
    return true;
  } catch {
    return false;
  }
}

// ---- snapshot pieces ----

function assertShopMetadata(shop) {
  if (typeof shop.name !== 'string') throw new MetricsError('bad_shape');
  if (!isShopifyDomain(shop.myshopifyDomain)) throw new MetricsError('bad_domain');
  const plan = shop.plan;
  if (plan && typeof plan.publicDisplayName !== 'string') throw new MetricsError('bad_shape');
}

/**
 * Keeps non-test, non-cancelled orders, validates currency/date/amount, newest first.
 * @returns {PreparedOrder[]}
 */
function prepareOrders(rawOrders, currency) {
  const prepared = [];
  for (const order of rawOrders) {
    if (order.test || order.cancelledAt) continue;
    const money = order.currentTotalPriceSet?.shopMoney;
    if (!money || money.currencyCode !== currency) throw new MetricsError('currency_mismatch');
    prepared.push({ order, at: parseInstant(order.createdAt), cents: parseCents(money.amount) });
  }
  prepared.sort((first, second) => second.at - first.at);
  return prepared;
}

// Local calendar anchors for today and for full-day windows with their equal-length predecessors.
function buildReportingWindows(nowMs, timeZone) {
  const today = localDate(nowMs, timeZone);
  return {
    today,
    yesterday: addDays(today, -1),
    todayStart: localToInstant(today, timeZone),
    weekStart: localToInstant(addDays(today, -WEEK_DAYS), timeZone),
    previousWeekStart: localToInstant(addDays(today, -WEEK_DAYS * 2), timeZone),
    days30Start: localToInstant(addDays(today, -THIRTY_DAYS), timeZone),
    previousDays30Start: localToInstant(addDays(today, -THIRTY_DAYS * 2), timeZone),
    days60Start: localToInstant(addDays(today, -SIXTY_DAYS), timeZone),
    previousDays60Start: localToInstant(addDays(today, -SIXTY_DAYS * 2), timeZone),
  };
}

// Totals for orders created in [fromMs, toMs).
function summarizeRange(orders, fromMs, toMs) {
  let valueCents = 0;
  let orderCount = 0;
  for (const prepared of orders) {
    if (prepared.at < fromMs || prepared.at >= toMs) continue;
    valueCents = addCents(valueCents, prepared.cents);
    orderCount++;
  }
  return summarizeTotals(valueCents, orderCount);
}

function summarizeTotals(valueCents, orderCount) {
  return {
    valueCents,
    orders: orderCount,
    averageCents: orderCount ? Math.round(valueCents / orderCount) : 0,
  };
}

// Orders on `date` at or before the same local clock time as `cutoffMs`.
// Wall-clock comparison also works when that day had a missing/repeated DST hour.
function summarizeSameLocalTime(orders, date, cutoffMs, timeZone) {
  const formatter = getFormatter(timeZone);
  const cutoffClock = millisecondsIntoLocalDay(cutoffMs, formatter);
  const selected = orders.filter(
    (prepared) =>
      localDate(prepared.at, timeZone) === date &&
      millisecondsIntoLocalDay(prepared.at, formatter) <= cutoffClock,
  );
  return summarizeRange(selected, -Infinity, Infinity);
}

function buildPeriods(orders, windows, nowMs, timeZone, historyStartMs) {
  const { today, yesterday, todayStart, weekStart, previousWeekStart } = windows;
  const { days30Start, previousDays30Start, days60Start, previousDays60Start } = windows;
  // Never compare against days that were not fetched; zeros there would be invented.
  if (previousDays60Start < historyStartMs) throw new MetricsError('bad_date');
  return {
    days60: {
      label: `${addDays(today, -SIXTY_DAYS)} to ${addDays(today, -1)}`,
      comparisonLabel: `compared with previous ${SIXTY_DAYS} full days`,
      current: summarizeRange(orders, days60Start, todayStart),
      previous: summarizeRange(orders, previousDays60Start, days60Start),
    },
    month: {
      label: `${addDays(today, -THIRTY_DAYS)} to ${addDays(today, -1)}`,
      comparisonLabel: `compared with previous ${THIRTY_DAYS} full days`,
      current: summarizeRange(orders, days30Start, todayStart),
      previous: summarizeRange(orders, previousDays30Start, days30Start),
    },
    week: {
      label: `${addDays(today, -WEEK_DAYS)} to ${addDays(today, -1)}`,
      comparisonLabel: `compared with previous ${WEEK_DAYS} full days`,
      current: summarizeRange(orders, weekStart, todayStart),
      previous: summarizeRange(orders, previousWeekStart, weekStart),
    },
    today: {
      label: today,
      comparisonLabel: 'compared with yesterday at same local time',
      current: summarizeRange(orders, todayStart, nowMs + 1),
      previous: summarizeSameLocalTime(orders, yesterday, nowMs, timeZone),
    },
  };
}

// Axis label of one day in a daily chart; '' where the chart leaves the point unlabelled.
function dayLabel(day, index, dayCount) {
  if (dayCount === WEEK_DAYS) return weekdayLabel(day);
  const labelEveryNDays = DATE_LABEL_EVERY_N_DAYS.get(dayCount);
  const isFirst = index === 0;
  const isLast = index === dayCount - 1;
  // A regular label in the last half interval would crowd the label of the last day.
  const isRegular =
    index % labelEveryNDays === 0 && dayCount - 1 - index >= Math.floor(labelEveryNDays / 2);
  return isFirst || isLast || isRegular ? formatMonthDay(day) : '';
}

// Daily order value for the `dayCount` days before today and the `dayCount` days before those.
function buildDaysChart(orders, dayCount, windows, timeZone) {
  const { today } = windows;
  const currentDays = [];
  const previousDays = [];
  for (let offset = -dayCount; offset < 0; offset++) {
    currentDays.push(addDays(today, offset));
    previousDays.push(addDays(today, offset - dayCount));
  }

  const centsByDay = new Map();
  for (const day of previousDays) centsByDay.set(day, 0);
  for (const day of currentDays) centsByDay.set(day, 0);
  for (const prepared of orders) {
    const day = localDate(prepared.at, timeZone);
    if (centsByDay.has(day)) {
      centsByDay.set(day, addCents(centsByDay.get(day), prepared.cents));
    }
  }

  const toPoint = (day, index) => ({
    date: day,
    label: dayLabel(day, index, dayCount),
    valueCents: centsByDay.get(day) ?? 0,
  });

  return {
    current: currentDays.map(toPoint),
    previous: previousDays.map(toPoint),
  };
}

function buildTodayChart(orders, windows, nowMs, timeZone) {
  const { today, yesterday } = windows;
  const formatter = getFormatter(timeZone);
  const currentHour = wallClockParts(nowMs, formatter).hour;
  const todayCents = new Array(24).fill(0);
  const yesterdayCents = new Array(24).fill(0);

  for (const prepared of orders) {
    const date = localDate(prepared.at, timeZone);
    const hour = wallClockParts(prepared.at, formatter).hour;
    if (date === today && hour <= currentHour) {
      todayCents[hour] = addCents(todayCents[hour], prepared.cents);
    } else if (date === yesterday) {
      yesterdayCents[hour] = addCents(yesterdayCents[hour], prepared.cents);
    }
  }

  const toPoint = (hour, centsByHour) => {
    const hourText = `${String(hour).padStart(2, '0')}:00`;
    return {
      date: `${today}T${hourText}`,
      label: TODAY_CHART_LABEL_HOURS.has(hour) ? hourText : '',
      valueCents: centsByHour[hour],
    };
  };

  return {
    current: Array.from({ length: 24 }, (_, hour) => toPoint(hour, todayCents)),
    previous: Array.from({ length: 24 }, (_, hour) => toPoint(hour, yesterdayCents)),
  };
}

// Paid (or partly paid) orders still waiting to be fulfilled. Fetched coverage only.
function summarizeBacklog(orders, nowMs) {
  let count = 0;
  let overdueCount = 0;
  for (const prepared of orders) {
    const { displayFinancialStatus, displayFulfillmentStatus } = prepared.order;
    if (!BACKLOG_PAYMENT_STATUSES.has(displayFinancialStatus)) continue;
    if (!BACKLOG_FULFILLMENT_STATUSES.has(displayFulfillmentStatus)) continue;
    count++;
    if (nowMs - prepared.at > OVERDUE_AFTER_MS) overdueCount++;
  }
  return { count, overdueCount };
}

function summarizeInventory(variants) {
  let trackedVariants = 0;
  let lowCount = 0;
  let firstLowVariant = null;
  for (const variant of variants) {
    if (variant.inventoryItem?.tracked !== true) continue;
    if (!Number.isInteger(variant.inventoryQuantity)) throw new MetricsError('bad_inventory');
    trackedVariants++;
    if (variant.inventoryQuantity <= LOW_STOCK_THRESHOLD) {
      lowCount++;
      firstLowVariant ??= variant;
    }
  }
  return { trackedVariants, lowCount, firstLowVariant };
}

function buildCoverageNotes(raw) {
  const notes = [
    `Older order backlog is unavailable: orders are only read for the last ${HISTORY_DAYS} days.`,
  ];
  if (!raw.ordersComplete) {
    notes.push('Order list is incomplete (page cap or cursor problem); totals may be too low.');
  }
  if (!raw.inventoryComplete) {
    notes.push('Inventory list is incomplete (page cap or cursor problem).');
  }
  return notes;
}

function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}

function buildAttention({ raw, domain, overdueCount, inventory }) {
  const items = [];
  if (!raw.ordersComplete) {
    items.push({
      id: 'orders-incomplete',
      title: 'Order data incomplete',
      description: 'Not all orders could be read; totals may be too low.',
    });
  }
  if (overdueCount) {
    items.push({
      id: 'overdue',
      title: `${overdueCount} ${pluralize(overdueCount, 'order', 'orders')} waiting over 24h`,
      description: `Paid or partly paid · Last ${HISTORY_DAYS} days`,
      url: `https://${domain}/admin/orders`,
    });
  }
  if (inventory.lowCount) {
    const { firstLowVariant, lowCount } = inventory;
    const variantName = firstLowVariant.displayName || 'Tracked variant';
    const moreText = lowCount > 1 ? ` · ${lowCount - 1} more` : '';
    items.push({
      id: 'low-stock',
      title: `${lowCount} low-stock ${pluralize(lowCount, 'variant', 'variants')}`,
      description: `${variantName} · ${firstLowVariant.inventoryQuantity} available${moreText}`,
      url: `https://${domain}/admin/products/inventory`,
    });
  }
  if (!raw.inventoryComplete) {
    items.push({
      id: 'inventory-incomplete',
      title: 'Inventory data incomplete',
      description: 'Not all variants could be read.',
    });
  }
  return items.slice(0, MAX_ATTENTION_ITEMS);
}

function buildRecentOrders(orders, domain) {
  return orders.slice(0, RECENT_ORDER_COUNT).map((prepared) => ({
    number: prepared.order.name,
    createdAt: new Date(prepared.at).toISOString(),
    amountCents: prepared.cents,
    paymentStatus: prepared.order.displayFinancialStatus,
    fulfillmentStatus: prepared.order.displayFulfillmentStatus,
    url: adminUrl(domain, prepared.order.id),
  }));
}

/**
 * Builds the dashboard snapshot from raw Shopify data. Throws MetricsError on any invalid input.
 * @param {import('./shopify/shop-data.mjs').RawShopData} raw
 * @param {Date} now
 * @returns {Snapshot}
 */
export function buildSnapshot(raw, now = new Date()) {
  const { shop } = raw;
  const timeZone = shop.ianaTimezone;
  const currency = shop.currencyCode;
  getFormatter(timeZone); // rejects an unknown time zone before any other work
  if (!Array.isArray(raw.orders) || !Array.isArray(raw.variants)) {
    throw new MetricsError('bad_shape');
  }
  assertShopMetadata(shop);
  const nowMs = now.getTime();
  const domain = shop.myshopifyDomain;

  const orders = prepareOrders(raw.orders, currency);
  const windows = buildReportingWindows(nowMs, timeZone);
  const backlog = summarizeBacklog(orders, nowMs);
  const inventory = summarizeInventory(raw.variants);
  const charts = {
    days60: buildDaysChart(orders, SIXTY_DAYS, windows, timeZone),
    month: buildDaysChart(orders, THIRTY_DAYS, windows, timeZone),
    week: buildDaysChart(orders, WEEK_DAYS, windows, timeZone),
    today: buildTodayChart(orders, windows, nowMs, timeZone),
  };

  return {
    source: 'shopify',
    shop: {
      name: shop.name,
      domain,
      currency,
      timeZone,
      plan: shop.plan ? shop.plan.publicDisplayName : null,
    },
    fetchedAt: now.toISOString(),
    coverage: {
      since: raw.since.toISOString(),
      until: raw.until.toISOString(),
      historyDays: HISTORY_DAYS,
      ordersComplete: raw.ordersComplete,
      inventoryComplete: raw.inventoryComplete,
      notes: buildCoverageNotes(raw),
    },
    periods: buildPeriods(orders, windows, nowMs, timeZone, raw.since.getTime()),
    chart: charts.week,
    charts,
    recentOrders: buildRecentOrders(orders, domain),
    attention: buildAttention({ raw, domain, overdueCount: backlog.overdueCount, inventory }),
    backlog: { count: backlog.count, overdueCount: backlog.overdueCount },
    inventory: { trackedVariants: inventory.trackedVariants, lowCount: inventory.lowCount },
    metricDefinition: METRIC_DEFINITION,
  };
}
