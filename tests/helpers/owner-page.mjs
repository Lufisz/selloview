// Runs the real owner page controller (public/owner/owner.js) in a child process against a fake page
// and SYNTHETIC server answers, then plays a script of what the owner does. No browser is available
// here, so this catches wiring and state mistakes; it does not replace looking at the page.
// Time is a script too: the page's own timers do not run until an action says "tick".
import { execFileSync } from 'node:child_process';

const CONTROLLER_URL = new URL('../../public/owner/owner.js', import.meta.url).href;
const REQUEST_TIMEOUT_MS = 12000;

// Server answers every owner scenario needs. All SYNTHETIC.
export const SYNTHETIC_STORE = 'flow-shop.myshopify.com';
export const answer = (status, body) => ({ status, body });
export const SIGNED_OUT = answer(401, { error: 'unauthenticated' });
export const NO_SCREENS = answer(200, { screens: [] });

/** The answer to loading the session of a signed-in owner. */
export function ownerSession({ settings = { period: 'week', theme: 'light' }, revision = 0 } = {}) {
  return answer(200, {
    owner: { email: 'owner@example.test' },
    sessionExpiresAt: '2099-01-01T00:00:00.000Z',
    workspace: { name: 'My MetricTV', revision, settings },
    storeConnection: { state: 'setup_required', canConnect: false },
    csrfToken: 'owner-csrf-token',
  });
}

/** The answer to loading the store connection; `snapshot` only for a connected store. */
export function storeAnswer({ state = 'not_connected', sync, snapshot = null, status = 200 } = {}) {
  const connection = { state, store: SYNTHETIC_STORE, canConnect: true, ...(sync ? { sync } : {}) };
  return answer(status, { connection, snapshot });
}

/**
 * @param {object} [options]
 * @param {Record<string, Array<{status: number, body: object}|'network-error'>>} [options.routes]
 *   Answers per address, used in order; the last one repeats. An address that is not listed fails
 *   the page as an unexpected request.
 * @param {string} [options.search]  The address bar's query string when the page opens.
 * @param {string} [options.pathname]  '/app', or '/register' for the sign-up page.
 * @param {Array<object>} [options.actions]  What the owner does, in order:
 *   {type: 'submit', form, fields}  a form with its text fields filled in
 *   {type: 'click', action, id}     a button with data-action (and data-id)
 *   {type: 'change', id, value}     a select outside a form, such as the board's period picker
 *   {type: 'input', form, name, value}  typing in a field of a form
 *   {type: 'toggle', key, open}     a click on the <summary> of the <details data-details-key=key>;
 *                                   `open` is whether it was open before the click
 *   {type: 'tick'}                  the page's oldest pending timer fires
 * @returns {{steps: Array<{html: string, requests: object[], timers: number[], theme: string}>,
 *   html: string, timers: number[], requests: object[], assigned: string[], replaced: string[],
 *   failures: string[]}}
 *   One step per moment: after start-up, then after each action. `requests` of a step are those
 *   made since the step before; `html` and `timers` of the result are those of the last step.
 */
export function runOwnerPage({ routes = {}, search = '', pathname = '/app', actions = [] } = {}) {
  const script = `
    const listeners = {};
    const app = {
      innerHTML: '',
      addEventListener: (type, handler) => { listeners[type] = handler; },
      querySelector: () => null,
      contains: () => false,
    };
    const requests = [];
    const assigned = [];
    const replaced = [];
    const failures = [];
    globalThis.document = {
      querySelector: () => app,
      body: { dataset: {}, classList: { toggle: () => {} } },
      activeElement: null,
    };
    globalThis.window = {
      location: {
        search: ${JSON.stringify(search)},
        hash: '',
        pathname: ${JSON.stringify(pathname)},
        origin: 'https://metrictv.example.test',
        assign: (url) => assigned.push(url),
      },
      history: { replaceState: (state, title, url) => replaced.push(url) },
    };
    globalThis.FormData = class {
      constructor(form) { this.fields = form.fields; }
      get(name) { return name in this.fields ? this.fields[name] : null; }
      has(name) { return name in this.fields; }
    };

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
    globalThis.fetch = async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : null,
        csrf: options.headers && options.headers['X-CSRF-Token'] ? options.headers['X-CSRF-Token'] : null,
      });
      const answers = routes[url];
      if (!answers) throw new Error('unexpected request ' + url);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer === 'network-error') throw new Error('synthetic network failure');
      return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => answer.body };
    };
    process.on('unhandledRejection', (error) => failures.push(error.message));

    const settle = async () => {
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    let reported = 0;
    const steps = [];
    const recordStep = () => {
      steps.push({
        html: app.innerHTML,
        requests: requests.slice(reported),
        timers: pendingTimers().map((timer) => timer.delay),
        theme: document.body.dataset.theme,
      });
      reported = requests.length;
    };

    function perform(action) {
      if (action.type === 'tick') {
        const [next] = pendingTimers();
        if (!next) throw new Error('no timer is waiting');
        next.fired = true;
        next.task();
      } else if (action.type === 'submit') {
        listeners.submit({
          preventDefault() {},
          target: { dataset: { form: action.form }, fields: action.fields || {} },
        });
      } else if (action.type === 'click') {
        const button = {
          dataset: { action: action.action, id: action.id },
          closest: (selector) => (selector === '[data-action]' ? button : null),
        };
        listeners.click({ target: button });
      } else if (action.type === 'change') {
        listeners.change({ target: { id: action.id, value: action.value } });
      } else if (action.type === 'input') {
        const form = { dataset: { form: action.form } };
        const field = {
          name: action.name,
          value: action.value,
          closest: (selector) => (selector === 'form[data-form]' ? form : null),
        };
        listeners.input({ target: field });
      } else if (action.type === 'toggle') {
        const details = { dataset: { detailsKey: action.key }, open: action.open };
        const summary = { closest: () => details };
        listeners.click({ target: { closest: (selector) => (selector === 'summary' ? summary : null) } });
      } else {
        throw new Error('unknown action ' + action.type);
      }
    }

    await import(${JSON.stringify(CONTROLLER_URL)});
    await settle();
    recordStep();
    for (const action of ${JSON.stringify(actions)}) {
      perform(action);
      await settle();
      recordStep();
    }
    console.log(JSON.stringify({ steps, requests, assigned, replaced, failures }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10000,
    }),
  );
  const last = result.steps[result.steps.length - 1];
  return { ...result, html: last.html, timers: last.timers };
}
