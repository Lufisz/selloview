// Runs the real TV page controller (public/tv/tv.js) in a child process against a fake page,
// SYNTHETIC server answers and an older-browser API surface (no Object.hasOwn, replaceAll or
// AbortSignal.timeout). Time is a script: the page's own timers do not run until a test asks.
import { execFileSync } from 'node:child_process';

const CONTROLLER_URL = new URL('../../public/tv/tv.js', import.meta.url).href;
const REQUEST_TIMEOUT_MS = 12000;

/**
 * @param {object} [options]
 * @param {Record<string, Array<{status: number, body: object}|'network-error'>>} [options.routes]
 *   Answers per address, used in order; the last one repeats. An address that is not listed fails
 *   the page as an unexpected request.
 * @param {boolean} [options.offline]  Every request fails, as with no network.
 * @param {number} [options.ticks]  How many of the page's own timers to fire after it started, in
 *   the order it set them.
 * @returns {{steps: Array<{html: string, timers: number[]}>, html: string, timers: number[],
 *   failures: string[], requests: string[], reloads: number}}
 *   One step per moment: after start-up, then after each tick. `html` and `timers` are those of
 *   the last step; `timers` are the delays of the page's own pending timers.
 */
export function runTvPage({ routes = {}, offline = false, ticks = 0 } = {}) {
  const script = `
    const app = { innerHTML: '' };
    const failures = [];
    const requests = [];
    const steps = [];
    let reloads = 0;
    globalThis.document = { querySelector: () => app, body: { dataset: {} } };
    globalThis.window = { location: { reload: () => { reloads += 1; } } };
    Object.hasOwn = undefined;
    String.prototype.replaceAll = undefined;
    AbortSignal.timeout = undefined;
    // Chance is a script too: the page's random reload delay is always half its spread.
    Math.random = () => 0.5;

    const scheduled = [];
    globalThis.setTimeout = (task, delay) => {
      const timer = { task, delay, cancelled: false, fired: false };
      scheduled.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
    // Every request arms its own abort timer; the page's polling timers are the others.
    const pendingTimers = () =>
      scheduled.filter((timer) => !timer.cancelled && !timer.fired && timer.delay !== ${REQUEST_TIMEOUT_MS});

    const routes = ${JSON.stringify(routes)};
    globalThis.fetch = async (url) => {
      requests.push(url);
      if (${JSON.stringify(offline)}) throw new Error('synthetic network failure');
      const answers = routes[url];
      if (!answers) throw new Error('unexpected request ' + url);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer === 'network-error') throw new Error('synthetic network failure');
      return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => answer.body };
    };
    process.on('unhandledRejection', (error) => failures.push(error.message));

    const settle = async () => {
      for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const recordStep = () => steps.push({ html: app.innerHTML, timers: pendingTimers().map((timer) => timer.delay) });

    await import(${JSON.stringify(CONTROLLER_URL)});
    await settle();
    recordStep();
    for (let tick = 0; tick < ${JSON.stringify(ticks)}; tick += 1) {
      const [next] = pendingTimers();
      if (!next) break;
      next.fired = true;
      next.task();
      await settle();
      recordStep();
    }
    console.log(JSON.stringify({ steps, failures, requests, reloads }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  );
  const last = result.steps.at(-1);
  return { ...result, html: last.html, timers: last.timers };
}
