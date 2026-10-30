// The sample board as a view model, built from the demo fixtures. It does for the sample what
// shared/board-model.js does for a real store snapshot, so one renderer draws both.
// The demo shows net sales; the real board shows order value.
import { money } from '../shared/format.js';

const DEMO_CURRENCY = 'EUR';
const DEMO_TIME_ZONE = 'Europe/Stockholm';
const DAY_LABELS = { today: '21 Oct 2026', week: '15–21 Oct 2026' };
const COMPARISON_LABELS = { today: 'sample day', week: '7 days' };

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

export function goalProgress(revenueCents, goalEuros) {
  return goalEuros > 0 ? Math.min(100, Math.max(0, (revenueCents / (goalEuros * 100)) * 100)) : 0;
}

function buildDemoMetrics({ data, settings, period }) {
  const { current, previous } = getPeriod(data.days, period);
  const weeklyRevenue = getPeriod(data.days, 'week').current.revenue;
  const comparisonName = COMPARISON_LABELS[period];
  const change = (currentValue, previousValue) => ({
    current: currentValue,
    previous: previousValue,
    srText: ` vs. previous ${comparisonName}`,
  });
  return [
    {
      label: 'Net sales',
      value: money(current.revenue, false, DEMO_CURRENCY),
      help: { action: 'sales-definition', label: 'How net sales are defined' },
      change: change(current.revenue, previous.revenue),
    },
    {
      label: 'Orders',
      value: String(current.orders),
      change: change(current.orders, previous.orders),
    },
    {
      label: 'Average order',
      value: money(current.averageOrder, false, DEMO_CURRENCY),
      change: change(current.averageOrder, previous.averageOrder),
    },
    {
      kind: 'goal',
      label: 'Weekly goal',
      percent: goalProgress(weeklyRevenue, settings.goal),
      target: `of ${money(settings.goal * 100, true, DEMO_CURRENCY)}`,
    },
  ];
}

function buildDemoChart(data, period) {
  const { currentDays, previousDays } = getPeriod(data.days, period);
  // "Sample day" shows the latest seven daily totals, not an invented intraday curve.
  const chartCurrent = period === 'today' ? data.days.slice(-7) : currentDays;
  const chartPrevious = period === 'today' ? data.days.slice(0, 7) : previousDays;
  const toPoint = (day) => ({ label: day.label, value: day.revenue });
  return {
    title: 'Sales trend',
    ariaLabel:
      'Sample net sales by day. Solid green: current seven-day period. Dashed grey: previous seven-day period.',
    legend: ['This week', 'Previous week'],
    current: chartCurrent.map(toPoint),
    previous: chartPrevious.map(toPoint),
    currency: DEMO_CURRENCY,
    axisStep: 20000,
    plotStart: 48,
    dotRadius: 4,
    emptyText: 'No sample days available.',
  };
}

function buildDemoAttention(items) {
  return {
    title: 'Needs attention',
    emptyText: 'Nothing needs attention.',
    items: items.map((item) => ({
      title: item.title,
      description: item.description,
      tone: item.tone,
      action: { type: 'button', action: 'attention', id: item.id, label: item.action },
    })),
  };
}

function buildDemoOrders(orders) {
  return {
    title: 'Latest orders',
    emptyText: 'No sample orders.',
    columns: [
      { label: 'Order' },
      { label: 'Product' },
      { label: 'Destination' },
      { label: 'Status' },
      { label: 'Amount', alignRight: true },
      { label: 'Time', alignRight: true },
    ],
    rows: orders.map((order) => [
      { text: order.id, kind: 'id' },
      { text: order.product },
      { text: order.country, kind: 'muted' },
      { text: order.status, kind: 'status', fulfilled: order.status === 'Fulfilled' },
      { text: money(order.amount, false, DEMO_CURRENCY), kind: 'amount', alignRight: true },
      { text: order.time, kind: 'muted', alignRight: true },
    ]),
  };
}

/** @param {{data: object, settings: object, period: 'today'|'week', connectionError: boolean}} state */
export function buildDemoBoardModel({ data, settings, period, connectionError }) {
  return {
    title: settings.name,
    subtitle: DAY_LABELS[period],
    previewLabel: 'Demo · Sample data',
    periodOptions: [
      { value: 'week', label: 'Last 7 days' },
      { value: 'today', label: 'Sample day' },
    ],
    selectedPeriod: period,
    banner: connectionError
      ? {
          title: 'Sample connection interrupted.',
          message: 'Showing the last sample snapshot, not current data.',
          action: { label: 'Restore sample', name: 'restore' },
        }
      : null,
    changeStyle: 'arrows',
    metrics: buildDemoMetrics({ data, settings, period }),
    comparisonText: `Compared with previous ${COMPARISON_LABELS[period]}`,
    chart: buildDemoChart(data, period),
    attention: settings.showAttention ? buildDemoAttention(data.attention) : null,
    orders: settings.showOrders ? buildDemoOrders(data.orders) : null,
    status: connectionError ? { tone: 'amber', text: 'Cached sample · Offline' } : null,
    scope: `${DEMO_CURRENCY} · ${DEMO_TIME_ZONE}`,
  };
}
