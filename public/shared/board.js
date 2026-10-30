// Shared board renderers used by the sample demo, the owner board and the TV board.
//
// Contract: every function takes an explicit, already-normalised view model and
// returns an HTML string. This module never imports fixtures, never fetches and
// never reads global state. All text and numbers from the view model are escaped
// here, so callers do not need to pre-escape.
import { escapeHtml, hasOwn, money, percentChange } from './format.js';
import { icon, statusDot, actionButton, optionsHtml, safeShopifyAdminUrl } from './ui.js';

/**
 * @typedef {Object} ChartPoint
 * @property {string} label    x-axis label such as "Mon"
 * @property {number} value    minor currency units (cents)
 *
 * @typedef {Object} ChartModel
 * @property {string} title
 * @property {string} ariaLabel
 * @property {[string, string]} legend      labels for the current and previous series
 * @property {ChartPoint[]} current
 * @property {ChartPoint[]} previous
 * @property {string} currency
 * @property {number} axisStep              ceiling is rounded up to a multiple of this (cents)
 * @property {number} plotStart             x position of the first point
 * @property {number} dotRadius
 * @property {string} emptyText             shown instead of the chart when `current` is empty
 *
 * @typedef {Object} Change
 * @property {number} current
 * @property {number} previous
 * @property {string} [srText]              screen-reader-only suffix such as " vs. previous 7 days"
 *
 * @typedef {Object} Metric
 * @property {string} label
 * @property {string} value                 preformatted display text
 * @property {{action: string, label: string}} [help]   "i" button, hidden in previews
 * @property {Change} [change]
 * @property {string} [note]                plain text shown instead of a change badge
 * @property {'goal'} [kind]                goal metrics use `percent` and `target` instead
 * @property {number} [percent]
 * @property {string} [target]
 *
 * @typedef {Object} AttentionItem
 * @property {string} title
 * @property {string} description
 * @property {string} [tone]
 * @property {{type: 'button', action: string, id: string, label: string}
 *   | {type: 'link', href: string, label: string}} [action]
 *
 * @typedef {Object} OrderCell
 * @property {string} text
 * @property {'id'|'muted'|'amount'|'status'|'plain'} [kind]
 * @property {boolean} [alignRight]
 * @property {boolean} [fulfilled]          status cells only
 * @property {string} [href]                already restricted by the caller to Shopify admin URLs
 *
 * @typedef {Object} BoardModel
 * @property {string} title
 * @property {string} subtitle
 * @property {string} [logoUrl]             same-origin store logo shown instead of the title text
 * @property {string} [storeDomain]        required for clickable Shopify links
 * @property {string} [previewLabel]        label replacing the controls in preview mode
 * @property {{value: string, label: string}[]} periodOptions
 * @property {string} selectedPeriod
 * @property {{title?: string, message: string, action?: {label: string, name: string}}|null} banner
 * @property {'arrows'|'signs'} changeStyle
 * @property {Metric[]} metrics
 * @property {string} comparisonText
 * @property {ChartModel} chart
 * @property {{title: string, items: AttentionItem[], emptyText: string}|null} attention
 * @property {{title: string, note?: string, columns: {label: string, alignRight?: boolean}[],
 *   rows: OrderCell[][], emptyText: string}|null} orders
 * @property {{tone: string, text: string}|null} status  footnote status on the left
 * @property {string} scope                 footnote text on the right, e.g. "EUR · Europe/Stockholm"
 *
 * @typedef {Object} BoardOptions
 * @property {boolean} [preview]  landing-page preview: no controls, buttons or details
 * @property {boolean} [tv]       TV mode: no TV link, actions or detail sections
 * @property {boolean} [controls] false drops the period picker, for screens whose period is set elsewhere
 * @property {boolean} [tvLink]   false drops the "TV mode" link where the page has no TV route
 * @property {string} [detailsHtml]  extra trusted markup placed after the orders panel
 */

const CHART = {
  width: 760,
  height: 245,
  baseline: 193,
  plotHeight: 164,
  labelY: 232,
  rightEdge: 708,
  gridRight: 724,
};

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

const valueOf = (point) => finiteOrZero(point.value);

/** Class names joined by spaces; false and empty names are skipped. */
function classNames(...names) {
  return names.filter(Boolean).join(' ');
}

// The geometry comes from the caller's view model, so it is checked here: a bad number must not
// reach the picture as "NaN".
function hasUsableGeometry({ axisStep, plotStart, dotRadius }) {
  const hasAxis = Number.isFinite(axisStep) && axisStep > 0;
  const hasStart = Number.isFinite(plotStart) && plotStart >= 0 && plotStart < CHART.rightEdge;
  const hasDots = Number.isFinite(dotRadius) && dotRadius >= 0;
  return hasAxis && hasStart && hasDots;
}

/** Axis labels drop decimals only for whole currency units, so ticks never collapse into duplicates. */
function formatAxisMoney(cents, currency) {
  return money(cents, cents % 100 === 0, currency);
}

/** Percent-change badge, or a "no baseline" note when the previous value was zero. */
export function renderChange({ current, previous, srText = '' }, style = 'arrows') {
  const change = percentChange(finiteOrZero(current), finiteOrZero(previous));
  if (change === null) return '<span class="metric-comparison">No previous baseline</span>';
  const isPositive = change >= 0;
  const symbols = style === 'signs' ? { up: '+', down: '−' } : { up: '↗ ', down: '↘ ' };
  const symbol = isPositive ? symbols.up : symbols.down;
  const hiddenText = srText ? `<span class="sr-only">${escapeHtml(srText)}</span>` : '';
  return `<span class="change ${isPositive ? 'positive' : 'negative'}">${symbol}${Math.abs(change).toFixed(1)}%${hiddenText}</span>`;
}

// Both series share one scale, so a shorter one stops early instead of stretching.
function chartScale(chart) {
  const highest = Math.max(
    chart.axisStep,
    ...chart.current.map(valueOf),
    ...chart.previous.map(valueOf),
  );
  const ceiling = Math.ceil(highest / chart.axisStep) * chart.axisStep;
  const plotWidth = CHART.rightEdge - chart.plotStart;
  const pointCount = Math.max(chart.current.length, chart.previous.length);
  return {
    ceiling,
    xAt: (index) => chart.plotStart + index * (plotWidth / Math.max(1, pointCount - 1)),
    yAt: (cents) => CHART.baseline - (cents / ceiling) * CHART.plotHeight,
  };
}

/**
 * Two-series line chart. Safe for empty, all-zero and non-finite values.
 * @param {ChartModel} chart
 */
export function renderChart(chart, { preview = false } = {}) {
  if (!chart.current.length || !hasUsableGeometry(chart)) {
    return `<p class="live-empty">${escapeHtml(chart.emptyText)}</p>`;
  }
  const { ceiling, xAt, yAt } = chartScale(chart);
  const polylinePoints = (points) =>
    points.map((point, index) => `${xAt(index)},${yAt(valueOf(point))}`).join(' ');
  const currentPoints = polylinePoints(chart.current);

  const gridMarkup = [0, 0.5, 1]
    .map((fraction) => {
      const cents = Math.round(ceiling * fraction);
      const y = yAt(cents);
      const labelText = escapeHtml(formatAxisMoney(cents, chart.currency));
      return `<line x1="${chart.plotStart - 4}" y1="${y}" x2="${CHART.gridRight}" y2="${y}" class="gridline"/>
    <text x="0" y="${y + 4}">${labelText}</text>`;
    })
    .join('\n    ');
  const dotRadius = preview ? 3 : chart.dotRadius;
  const dotMarkup =
    dotRadius > 0
      ? chart.current
          .map(
            (point, index) =>
              `<circle cx="${xAt(index)}" cy="${yAt(valueOf(point))}" r="${dotRadius}" class="chart-dot"/>`,
          )
          .join('\n    ')
      : '';
  const labelMarkup = chart.current
    .map(
      (point, index) =>
        `<text x="${xAt(index)}" y="${CHART.labelY}" text-anchor="middle">${escapeHtml(point.label)}</text>`,
    )
    .join('\n    ');

  return `<svg class="revenue-chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${escapeHtml(chart.ariaLabel)}">
    ${gridMarkup}
    <polygon points="${chart.plotStart},${CHART.baseline} ${currentPoints} ${xAt(chart.current.length - 1)},${CHART.baseline}" class="chart-area"/>
    <polyline points="${polylinePoints(chart.previous)}" class="chart-previous"/>
    <polyline points="${currentPoints}" class="chart-current"/>
    ${dotMarkup}
    ${labelMarkup}
  </svg>`;
}

function renderGoalMetric(metric) {
  const percent = Math.min(100, Math.max(0, finiteOrZero(metric.percent)));
  const rounded = Math.round(percent);
  return `<section class="metric goal-metric">
      <div class="metric-label">${escapeHtml(metric.label)}</div>
      <div class="goal-values"><div class="metric-value">${rounded}<span class="percent-symbol">%</span></div><span>${escapeHtml(metric.target)}</span></div>
      <div class="progress-track" role="progressbar" aria-label="Weekly sales goal" aria-valuenow="${rounded}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>
    </section>`;
}

/** @param {Metric} metric */
export function renderMetric(metric, { preview = false, changeStyle = 'arrows' } = {}) {
  if (metric.kind === 'goal') return renderGoalMetric(metric);
  const helpButton =
    metric.help && !preview
      ? ` <button class="help-button" aria-label="${escapeHtml(metric.help.label)}" data-action="${escapeHtml(metric.help.action)}">i</button>`
      : '';
  let bottomHtml = '';
  if (metric.change) {
    bottomHtml = `<div class="metric-bottom">${renderChange(metric.change, changeStyle)}</div>`;
  } else if (metric.note !== undefined) {
    bottomHtml = `<div class="metric-comparison">${escapeHtml(metric.note)}</div>`;
  }
  return `<section class="metric">
    <div class="metric-label">${escapeHtml(metric.label)}${helpButton}</div>
    <div class="metric-value">${escapeHtml(metric.value)}</div>
    ${bottomHtml}
  </section>`;
}

function renderAttentionAction(action, hideActions, storeDomain) {
  if (!action || hideActions) return '';
  if (action.type === 'button') {
    return actionButton({
      action: action.action,
      label: action.label,
      iconName: 'arrow',
      data: { id: action.id },
    });
  }
  const href = safeShopifyAdminUrl(action.href, storeDomain);
  if (action.type === 'link' && href) {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-button">${escapeHtml(action.label)} ${icon('arrow')}</a>`;
  }
  return '';
}

export function renderAttentionPanel(attention, { hideActions = false, storeDomain } = {}) {
  const itemsHtml = attention.items
    .map(
      (item) => `
    <article class="attention-item">
      <h3>${statusDot(item.tone)}${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      ${renderAttentionAction(item.action, hideActions, storeDomain)}
    </article>`,
    )
    .join('');
  return `<aside class="attention-panel">
    <div class="section-heading"><h2>${escapeHtml(attention.title)}</h2><span class="count">${attention.items.length}</span></div>
    ${attention.items.length ? itemsHtml : `<p class="live-empty">${escapeHtml(attention.emptyText)}</p>`}
  </aside>`;
}

const CELL_CLASSES = {
  id: 'order-id',
  muted: 'muted',
  amount: 'order-amount',
  status: '',
  plain: '',
};

function renderOrderCell(cell, storeDomain) {
  const kindClass = hasOwn(CELL_CLASSES, cell.kind) ? CELL_CLASSES[cell.kind] : '';
  const classes = classNames(cell.alignRight && 'align-right', kindClass);
  const classAttribute = classes ? ` class="${classes}"` : '';
  let inner = escapeHtml(cell.text);
  const href = safeShopifyAdminUrl(cell.href, storeDomain);
  if (cell.kind === 'status') {
    inner = `<span class="order-status ${cell.fulfilled ? 'fulfilled' : ''}">${inner}</span>`;
  } else if (href) {
    inner = `<a class="quiet-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  }
  return `<td${classAttribute}>${inner}</td>`;
}

export function renderOrdersPanel(orders, { storeDomain } = {}) {
  const noteHtml = orders.note ? `<span class="muted">${escapeHtml(orders.note)}</span>` : '';
  const headerHtml = orders.columns
    .map(
      (column) =>
        `<th${column.alignRight ? ' class="align-right"' : ''}>${escapeHtml(column.label)}</th>`,
    )
    .join('');
  const rowsHtml = orders.rows
    .map((row) => `<tr>${row.map((cell) => renderOrderCell(cell, storeDomain)).join('')}</tr>`)
    .join('\n        ');
  const tableHtml = `<div class="orders-scroll">
      <table>
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>
        ${rowsHtml}
        </tbody>
      </table>
    </div>`;
  return `<section class="orders-panel">
    <div class="section-heading"><h2>${escapeHtml(orders.title)}</h2>${noteHtml}</div>
    ${orders.rows.length ? tableHtml : `<p class="live-empty">${escapeHtml(orders.emptyText)}</p>`}
  </section>`;
}

function renderControls(model, { preview, tv, tvLink }) {
  if (preview) {
    return `<span class="snapshot-label">${statusDot('amber')} ${escapeHtml(model.previewLabel ?? '')}</span>`;
  }
  const tvLinkHtml =
    tv || !tvLink
      ? ''
      : `<a class="button small secondary" href="#/tv">${icon('screen')} TV mode</a>`;
  return `<label class="sr-only" for="period">Reporting period</label>
        <select id="period" aria-label="Reporting period">${optionsHtml(model.periodOptions, model.selectedPeriod)}</select>
        ${tvLinkHtml}`;
}

/** The store logo when there is one (its alt text keeps the name for screen readers), else the name. */
function renderTitle(model) {
  if (model.logoUrl) {
    return `<h1 class="board-logo-title"><img class="board-logo" src="${escapeHtml(model.logoUrl)}" alt="${escapeHtml(model.title)}"></h1>`;
  }
  return `<h1>${escapeHtml(model.title)}<span class="heading-dot">.</span></h1>`;
}

function renderBanner(banner) {
  if (!banner) return '';
  const titleHtml = banner.title ? `<strong>${escapeHtml(banner.title)}</strong> ` : '';
  const actionHtml = banner.action
    ? ` ${actionButton({ action: banner.action.name, label: banner.action.label })}`
    : '';
  return `<div class="error-banner" role="status">${titleHtml}${escapeHtml(banner.message)}${actionHtml}</div>`;
}

function renderHeading(model, { preview, tv, tvLink, controls }) {
  const controlsHtml = controls ? renderControls(model, { preview, tv, tvLink }) : '';
  return `<div class="board-heading">
      <div>${renderTitle(model)}<p>${escapeHtml(model.subtitle)}</p></div>
      <div class="board-controls">${controlsHtml}</div>
    </div>`;
}

function renderChartPanel(chart, preview) {
  const [currentLegend, previousLegend] = chart.legend;
  return `<section class="chart-panel">
        <div class="section-heading">
          <h2>${escapeHtml(chart.title)}</h2>
          <div class="chart-legend">
            <span><i></i> ${escapeHtml(currentLegend)}</span>
            <span><i class="previous"></i> ${escapeHtml(previousLegend)}</span>
          </div>
        </div>
        ${renderChart(chart, { preview })}
      </section>`;
}

function renderFootnote(model) {
  const statusHtml = model.status
    ? `${statusDot(model.status.tone)} ${escapeHtml(model.status.text)}`
    : '';
  return `<div class="board-footnote"><span>${statusHtml}</span><span>${escapeHtml(model.scope)}</span></div>`;
}

/**
 * The whole board: heading, metrics, chart, attention, orders and footnote.
 * @param {BoardModel} model
 * @param {BoardOptions} [options]
 */
export function renderBoard(
  model,
  {
    preview = false,
    tv = false,
    tvOrders = false,
    detailsHtml = '',
    tvLink = true,
    controls = true,
  } = {},
) {
  const showDetails = !preview && !tv;
  // On a fitted TV screen the latest orders sit beside the chart instead of below it.
  const ordersBesideChart = tv && tvOrders && Boolean(model.orders);
  const metricsHtml = model.metrics
    .map((metric) => renderMetric(metric, { preview, changeStyle: model.changeStyle }))
    .join('');
  const attentionHtml = model.attention
    ? renderAttentionPanel(model.attention, {
        hideActions: preview || tv,
        storeDomain: model.storeDomain,
      })
    : '';
  const ordersHtml =
    (showDetails || ordersBesideChart) && model.orders
      ? renderOrdersPanel(model.orders, { storeDomain: model.storeDomain })
      : '';
  const boardClasses = classNames('board', preview && 'board-preview', tv && 'board-tv');
  const mainClasses = classNames(
    'board-main',
    !attentionHtml && 'no-aside',
    ordersBesideChart && 'with-orders',
  );
  return `<div class="${boardClasses}">
    ${renderHeading(model, { preview, tv, tvLink, controls })}
    ${renderBanner(model.banner)}
    <div class="metrics">${metricsHtml}</div>
    <p class="metrics-context">${escapeHtml(model.comparisonText)}</p>
    <div class="${mainClasses}">
      ${renderChartPanel(model.chart, preview)}
      ${ordersBesideChart ? ordersHtml : ''}
      ${attentionHtml}
    </div>
    ${ordersBesideChart ? '' : ordersHtml}
    ${showDetails ? detailsHtml : ''}
    ${renderFootnote(model)}
  </div>`;
}
