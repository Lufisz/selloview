import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_PERIOD_OPTIONS,
  PERIODS,
  SETTINGS_PERIOD_OPTIONS,
  normalizePeriod,
} from '../../public/shared/periods.js';

test('every period names itself, describes its chart and bounds the chart', () => {
  const keys = Object.keys(PERIODS);
  assert.deepEqual(keys, ['today', 'week', 'month', 'days60']);
  for (const key of keys) {
    const period = PERIODS[key];
    assert.ok(period.settingsLabel && period.pickerLabel, `${key} has both names`);
    assert.ok(Number.isInteger(period.maxChartPoints) && period.maxChartPoints > 0, key);
    assert.ok(period.chart.title && period.chart.ariaLabel, `${key} describes its chart`);
    assert.equal(period.chart.legend.length, 2, `${key} labels both series`);
    assert.ok(period.chart.dotRadius >= 0, key);
  }
});

test('the settings form lists the shortest period first, the board picker the longest first', () => {
  assert.deepEqual(SETTINGS_PERIOD_OPTIONS, [
    { value: 'today', label: 'Today' },
    { value: 'week', label: 'This week' },
    { value: 'month', label: 'This month' },
    { value: 'days60', label: 'Last 60 days' },
  ]);
  assert.deepEqual(BOARD_PERIOD_OPTIONS, [
    { value: 'days60', label: 'Last 60 full days' },
    { value: 'month', label: 'Last 30 full days' },
    { value: 'week', label: 'Last 7 full days' },
    { value: 'today', label: 'Today' },
  ]);
});

test('an unknown period falls back to the 7-day view', () => {
  for (const key of Object.keys(PERIODS)) {
    assert.equal(normalizePeriod(key), key);
  }
  for (const unknown of ['', 'year', undefined, null, 7, '__proto__', 'constructor']) {
    assert.equal(normalizePeriod(unknown), 'week', String(unknown));
  }
});
