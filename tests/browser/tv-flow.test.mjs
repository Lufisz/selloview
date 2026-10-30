// What an unattended TV does over time: pairing, polling, losing the connection and being sent
// away. The real controller runs against SYNTHETIC server answers; each tick is one of the page's
// own timers firing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticDisplay, syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';
import { runTvPage } from '../helpers/tv-page.mjs';
import { pollDelayMs } from '../../public/tv/tv-client.js';

const PAIRING_POLL_MS = 3000;
const DISPLAY_POLL_MS = 10000;
const RETRY_MS = 15000;
const RELOAD_SPREAD_MS = 60000;

const display = syntheticDisplay({
  screenName: 'Flow TV',
  snapshot: syntheticSnapshot({ shopName: 'Synthetic Flow Shop' }),
});
const answer = (status, body) => ({ status, body });
const unpaired = answer(401, { error: 'unauthenticated' });
const newCode = (code) => answer(201, { code });

test('a new screen shows a code, is approved, trades it and then shows the board', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [unpaired, answer(200, display)],
      '/api/tv/challenge': [newCode('ABCD-EFGH')],
      '/api/tv/pairing': [answer(200, { state: 'pending' }), answer(200, { state: 'approved' })],
      '/api/tv/pairing/exchange': [answer(200, { ok: true })],
    },
    ticks: 2,
  });
  const [waiting, stillWaiting, paired] = result.steps;

  assert.deepEqual(result.failures, []);
  assert.match(waiting.html, /ABCD-EFGH/);
  assert.deepEqual(waiting.timers, [PAIRING_POLL_MS]);
  assert.match(stillWaiting.html, /ABCD-EFGH/);
  assert.match(paired.html, /Synthetic Flow Shop/);
  assert.deepEqual(paired.timers, [DISPLAY_POLL_MS]);
  assert.deepEqual(result.requests, [
    '/api/display',
    '/api/tv/challenge',
    '/api/tv/pairing',
    '/api/tv/pairing',
    '/api/tv/pairing/exchange',
    '/api/display',
  ]);
});

test('a code that expired is replaced by a new one', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [unpaired],
      '/api/tv/challenge': [newCode('AAAA-AAAA'), newCode('BBBB-BBBB')],
      '/api/tv/pairing': [answer(404, { error: 'not_found' })],
    },
    ticks: 1,
  });

  assert.match(result.steps[0].html, /AAAA-AAAA/);
  assert.match(result.steps[1].html, /BBBB-BBBB/);
  assert.doesNotMatch(result.steps[1].html, /AAAA-AAAA/);
});

test('an approval that cannot be completed starts pairing again with a new code', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [unpaired],
      '/api/tv/challenge': [newCode('AAAA-AAAA'), newCode('BBBB-BBBB')],
      '/api/tv/pairing': [answer(200, { state: 'approved' })],
      '/api/tv/pairing/exchange': [answer(401, { error: 'unauthenticated' })],
    },
    ticks: 1,
  });

  assert.match(result.html, /BBBB-BBBB/);
  const lastRequests = result.requests.slice(-2);
  assert.deepEqual(
    lastRequests,
    ['/api/tv/pairing/exchange', '/api/tv/challenge'],
    'a refused trade goes straight to a new code, without asking for figures',
  );
});

test('a lost connection keeps the board and says so, and the next good answer clears the notice', () => {
  const result = runTvPage({
    routes: { '/api/display': [answer(200, display), 'network-error', answer(200, display)] },
    ticks: 2,
  });
  const [shown, lost, recovered] = result.steps;

  assert.doesNotMatch(shown.html, /Connection lost/);
  assert.match(lost.html, /Synthetic Flow Shop/);
  assert.match(lost.html, /Connection lost\. These figures may not be the latest\./);
  assert.deepEqual(lost.timers, [DISPLAY_POLL_MS], 'it keeps trying');
  assert.match(recovered.html, /Synthetic Flow Shop/);
  assert.doesNotMatch(recovered.html, /Connection lost/);
});

test('access that ends sends the TV back to a pairing code and drops the board', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [answer(200, display), unpaired],
      '/api/tv/challenge': [newCode('ABCD-EFGH')],
    },
    ticks: 1,
  });

  assert.match(result.html, /ABCD-EFGH/);
  assert.doesNotMatch(result.html, /Synthetic Flow Shop/);
});

test('after access ended, a new pairing never shows the board of the previous one', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [answer(200, display), unpaired, 'network-error'],
      '/api/tv/challenge': [newCode('ABCD-EFGH')],
      '/api/tv/pairing': [answer(200, { state: 'approved' })],
      '/api/tv/pairing/exchange': [answer(200, { ok: true })],
    },
    ticks: 2,
  });

  assert.match(result.steps[1].html, /ABCD-EFGH/);
  assert.doesNotMatch(result.html, /Synthetic Flow Shop/);
  assert.doesNotMatch(result.html, /Connection lost/);
  assert.deepEqual(result.timers, [DISPLAY_POLL_MS], 'it keeps asking until the server answers');
});

test('a pairing code that cannot be created says why and is asked for again later', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [unpaired],
      '/api/tv/challenge': [answer(429, { error: 'rate_limited' })],
    },
  });

  assert.match(result.html, /Too many requests from this network/);
  assert.deepEqual(result.timers, [RETRY_MS]);
});

test('a server that is unreachable at start-up is retried, not given up on', () => {
  const result = runTvPage({ offline: true });

  assert.match(result.html, /Cannot reach the server/);
  assert.deepEqual(result.timers, [RETRY_MS]);
});

const newVersionRoutes = {
  '/api/display': [
    answer(200, { ...display, appVersion: 'version-one' }),
    answer(200, {
      ...display,
      appVersion: 'version-two',
      screen: { name: 'Must not be drawn' },
    }),
  ],
};

test('newer page code reloads the page before anything is drawn from the new answer', () => {
  const result = runTvPage({ routes: newVersionRoutes, ticks: 2 });
  const [before, announced, replaced] = result.steps;

  assert.equal(result.reloads, 1);
  assert.equal(announced.html, before.html, 'the page is replaced, not redrawn');
  assert.doesNotMatch(announced.html, /Must not be drawn/);
  assert.deepEqual(replaced.timers, [], 'a page that is being replaced stops polling');
});

test('screens spread their reload over a minute instead of all reloading at once', () => {
  const result = runTvPage({ routes: newVersionRoutes, ticks: 1 });

  assert.deepEqual(
    result.timers,
    [RELOAD_SPREAD_MS / 2],
    'only the random reload delay is waiting',
  );
  assert.equal(result.reloads, 0, 'the reload waits for its timer');
});

test('the server sets the pace of the next poll, within bounds, and 10 s when it names none', () => {
  assert.equal(pollDelayMs({ pollSeconds: 30 }), 30000);
  assert.equal(pollDelayMs({ pollSeconds: 1 }), 5000, 'never faster than every 5 s');
  assert.equal(pollDelayMs({ pollSeconds: 86400 }), 300000, 'never slower than every 5 minutes');
  for (const unusable of [undefined, null, 'soon', NaN, Infinity]) {
    assert.equal(pollDelayMs({ pollSeconds: unusable }), DISPLAY_POLL_MS, String(unusable));
  }
  assert.equal(pollDelayMs(null), DISPLAY_POLL_MS);
});

test('a paired page waits as long as the server asked between polls', () => {
  const slower = answer(200, { ...display, pollSeconds: 30 });
  const result = runTvPage({ routes: { '/api/display': [slower] }, ticks: 2 });

  assert.deepEqual(
    result.steps.map((step) => step.timers),
    [[30000], [30000], [30000]],
  );
});

test('the same page version never reloads', () => {
  const sameVersion = answer(200, { ...display, appVersion: 'version-one' });
  const result = runTvPage({ routes: { '/api/display': [sameVersion] }, ticks: 3 });

  assert.equal(result.reloads, 0);
  assert.deepEqual(result.timers, [DISPLAY_POLL_MS]);
});
