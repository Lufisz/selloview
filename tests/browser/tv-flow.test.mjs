// What an unattended TV does over time: pairing, polling, losing the connection and being sent
// away. The real controller runs against SYNTHETIC server answers; each tick is one of the page's
// own timers firing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticDisplay, syntheticSnapshot } from '../helpers/synthetic-snapshot.mjs';
import { runTvPage } from '../helpers/tv-page.mjs';

const PAIRING_POLL_MS = 3000;
const DISPLAY_POLL_MS = 10000;
const RETRY_MS = 15000;

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

test('a server that is unreachable at start-up is retried, not given up on', () => {
  const result = runTvPage({ offline: true });

  assert.match(result.html, /Cannot reach the server/);
  assert.deepEqual(result.timers, [RETRY_MS]);
});

test('newer page code reloads the page before anything is drawn from the new answer', () => {
  const result = runTvPage({
    routes: {
      '/api/display': [
        answer(200, { ...display, appVersion: 'version-one' }),
        answer(200, {
          ...display,
          appVersion: 'version-two',
          screen: { name: 'Must not be drawn' },
        }),
      ],
    },
    ticks: 1,
  });
  const [before, after] = result.steps;

  assert.equal(result.reloads, 1);
  assert.equal(after.html, before.html, 'the page is replaced, not redrawn');
  assert.doesNotMatch(after.html, /Must not be drawn/);
  assert.deepEqual(after.timers, [], 'a page that is being replaced stops polling');
});

test('the same page version never reloads', () => {
  const sameVersion = answer(200, { ...display, appVersion: 'version-one' });
  const result = runTvPage({ routes: { '/api/display': [sameVersion] }, ticks: 3 });

  assert.equal(result.reloads, 0);
  assert.deepEqual(result.timers, [DISPLAY_POLL_MS]);
});
