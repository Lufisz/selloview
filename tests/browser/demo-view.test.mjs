import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SAMPLE_DAYS,
  SAMPLE_ORDERS,
  ATTENTION_ITEMS,
  DEFAULT_SETTINGS,
} from '../../public/demo/demo-data.js';
import {
  buildDemoBoardModel,
  renderHome,
  renderSetup,
  renderDashboard,
  renderSettings,
  renderConnections,
} from '../../public/demo/demo-view.js';

const demoState = {
  data: { days: SAMPLE_DAYS, orders: SAMPLE_ORDERS, attention: ATTENTION_ITEMS },
  settings: { ...DEFAULT_SETTINGS },
  period: 'week',
  connectionError: false,
};

test('demo model keeps net-sales wording and EUR sample totals', () => {
  const model = buildDemoBoardModel(demoState);
  assert.equal(model.metrics[0].label, 'Net sales');
  assert.equal(model.metrics[0].value, '€4,151.00');
  assert.equal(model.chart.axisStep, 20000);
  assert.equal(buildDemoBoardModel({ ...demoState, period: 'today' }).metrics[0].value, '€782.00');
});

test('demo pages render readable multi-line markup with expected selectors', () => {
  const pages = [
    renderHome(demoState),
    renderSetup({ step: 1, storeText: '', settings: demoState.settings }),
    renderDashboard(demoState),
    renderConnections(demoState),
    renderSettings(demoState),
  ];
  for (const html of pages) {
    const longest = Math.max(
      ...html
        .split('\n')
        .filter((line) => !/^\s*<poly/.test(line))
        .map((line) => line.length),
    );
    assert.ok(longest < 700, `line of ${longest} characters`);
  }
  assert.match(renderDashboard(demoState), /id="period"/);
  assert.match(renderSettings(demoState), /id="settings-name"/);
  assert.match(
    renderSetup({ step: 2, storeText: 'x.myshopify.com', settings: demoState.settings }),
    /data-action="approve"/,
  );
  assert.match(renderDashboard({ ...demoState, tv: true }), /class="tv-shell/);
});

test('demo escapes the editable business name and store text', () => {
  const settings = { ...demoState.settings, name: 'Studio <test>', store: '"><x>' };
  assert.equal(renderDashboard({ ...demoState, settings }).includes('<test>'), false);
  assert.equal(renderSetup({ step: 1, storeText: '"><b>', settings }).includes('"><b>'), false);
  assert.equal(renderConnections({ settings }).includes('"><x>'), false);
});

test('the demo never talks to a server', async () => {
  for (const file of ['demo.js', 'demo-view.js', 'demo-data.js']) {
    const source = await readFile(new URL(`../../public/demo/${file}`, import.meta.url), 'utf8');
    assert.equal(/\/api\/|fetch\s*\(/.test(source), false, `${file} talks to a server`);
  }
});
