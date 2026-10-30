// The four reporting periods as the browser names and draws them. The server decides how each one
// is computed (server/metrics.mjs) and which are accepted as a setting (server/accounts/
// workspaces.mjs); tests/server/settings-contract.test.mjs keeps the three lists in step.
// Shortest first, which is the order of the settings form. The TV page loads this module.
import { hasOwn } from './format.js';

export const PERIODS = Object.freeze({
  today: {
    settingsLabel: 'Today',
    pickerLabel: 'Today',
    maxChartPoints: 24,
    chart: {
      title: 'Hourly order value',
      legend: ['Today', 'Yesterday'],
      ariaLabel: 'Hourly order value. Solid green: today. Dashed grey: yesterday.',
      dotRadius: 3,
    },
  },
  week: {
    settingsLabel: 'This week',
    pickerLabel: 'Last 7 full days',
    maxChartPoints: 7,
    chart: {
      title: 'Daily order value',
      legend: ['Last 7 full days', 'Previous 7'],
      ariaLabel:
        'Daily order value. Solid green: last seven complete days. Dashed grey: preceding seven complete days.',
      dotRadius: 4,
    },
  },
  month: {
    settingsLabel: 'This month',
    pickerLabel: 'Last 30 full days',
    maxChartPoints: 30,
    chart: {
      title: 'Daily order value (30 days)',
      legend: ['Last 30 full days', 'Previous 30'],
      ariaLabel:
        'Daily order value. Solid green: last 30 complete days. Dashed grey: preceding 30 complete days.',
      dotRadius: 0,
    },
  },
  days60: {
    settingsLabel: 'Last 60 days',
    pickerLabel: 'Last 60 full days',
    maxChartPoints: 60,
    chart: {
      title: 'Daily order value (60 days)',
      legend: ['Last 60 full days', 'Previous 60'],
      ariaLabel:
        'Daily order value. Solid green: last 60 complete days. Dashed grey: preceding 60 complete days.',
      dotRadius: 0,
    },
  },
});

const DEFAULT_PERIOD = 'week';

/** Returns a known period key, defaulting to the 7-day view. */
export function normalizePeriod(value) {
  return hasOwn(PERIODS, value) ? value : DEFAULT_PERIOD;
}

/** The settings form's choices, shortest period first. */
export const SETTINGS_PERIOD_OPTIONS = Object.freeze(
  Object.keys(PERIODS).map((key) => ({ value: key, label: PERIODS[key].settingsLabel })),
);

/** The board's period picker, longest period first. */
export const BOARD_PERIOD_OPTIONS = Object.freeze(
  Object.keys(PERIODS)
    .reverse()
    .map((key) => ({ value: key, label: PERIODS[key].pickerLabel })),
);
