// Beta configuration, private database safety, mail transport, operator CLI, a real server
// process, and the browser-side helpers. Provider calls use a fake fetch: nothing leaves the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBetaConfig } from '../server/main.mjs';
import {
  PrivateDatabaseError,
  createPrivateDatabaseFile,
  openPrivateDatabase,
  parseDatabasePath,
} from '../server/accounts/private-database.mjs';
import {
  DeliveryError,
  createResendTransport,
  loadMailConfig,
  unconfiguredTransport,
} from '../server/accounts/mail-transport.mjs';
import { normalizeInviteEmail } from '../server/accounts/accounts.mjs';
import {
  ERROR_MESSAGES,
  loadOwnerSession,
  messageForError,
  parseCode,
  parseEmail,
  requestSignInCode,
  saveWorkspaceSettings,
  signOut,
  verifySignInCode,
} from '../public/owner/owner-client.js';
import { renderOwner, renderSignIn } from '../public/owner/owner-view.js';
import {
  curlAvailable,
  findFreePort,
  httpRequest,
  makeTemporaryDirectory,
} from './beta-helpers.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID_SECRET = 'S'.repeat(40);
const GOOD_ENV = {
  BETA_DB_PATH: '/var/tmp/metrictv-beta-private/beta.sqlite',
  BETA_AUTH_SECRET: VALID_SECRET,
  BETA_ORIGIN: 'https://beta.example.test',
};

test('configuration rejects unsafe or missing values instead of defaulting', () => {
  const config = loadBetaConfig(GOOD_ENV);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.origin, 'https://beta.example.test');
  assert.equal(config.port, 4330);

  const badChanges = [
    { BETA_DB_PATH: undefined },
    { BETA_DB_PATH: 'relative/beta.sqlite' },
    { BETA_DB_PATH: '/var/tmp/../tmp/beta.sqlite' },
    { BETA_DB_PATH: '/var/tmp/beta.db' },
    { BETA_DB_PATH: path.join(PROJECT_ROOT, 'state', 'beta.sqlite') },
    { BETA_AUTH_SECRET: 'short' },
    { BETA_AUTH_SECRET: undefined },
    { BETA_ORIGIN: undefined },
    { BETA_ORIGIN: 'http://beta.example.test' },
    { BETA_ORIGIN: 'https://beta.example.test/' },
    { BETA_ORIGIN: 'https://beta.example.test/path' },
    { BETA_ORIGIN: 'https://user:pass@beta.example.test' },
    { BETA_PORT: '0' },
    { BETA_PORT: 'abc' },
    { BETA_TRUSTED_IP_HEADER: 'bad header' },
  ];
  for (const change of badChanges) {
    assert.throws(() => loadBetaConfig({ ...GOOD_ENV, ...change }), Error, JSON.stringify(change));
  }
  assert.equal(
    loadBetaConfig({ ...GOOD_ENV, BETA_ORIGIN: 'http://127.0.0.1:4330' }).origin,
    'http://127.0.0.1:4330',
  );
});

test('the private database is created once, private, outside the project, and never auto-created', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'nested', 'beta.sqlite');
  assert.equal(parseDatabasePath(databasePath), databasePath);

  assert.throws(
    () => openPrivateDatabase(databasePath),
    (error) => error instanceof PrivateDatabaseError && error.code === 'not_initialized',
  );
  await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });

  createPrivateDatabaseFile(databasePath);
  const directoryMode = (await fs.stat(path.dirname(databasePath))).mode & 0o777;
  const fileMode = (await fs.stat(databasePath)).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);

  assert.throws(
    () => createPrivateDatabaseFile(databasePath),
    (error) => error.code === 'already_exists',
  );

  await fs.chmod(databasePath, 0o644);
  assert.throws(
    () => openPrivateDatabase(databasePath),
    (error) => error.code === 'unsafe_file',
  );
  await fs.chmod(databasePath, 0o600);

  const linkPath = path.join(path.dirname(databasePath), 'link.sqlite');
  await fs.symlink(databasePath, linkPath);
  assert.throws(
    () => openPrivateDatabase(linkPath),
    (error) => error.code === 'unsafe_file',
  );
});

test('invite emails are normalized and strictly validated', () => {
  assert.equal(normalizeInviteEmail('  Owner@Example.TEST '), 'owner@example.test');
  for (const bad of [
    '',
    'no-at',
    'a@b',
    'a b@example.test',
    'a@exa mple.test',
    '<a@example.test>',
    'a@@example.test',
    null,
    7,
  ]) {
    assert.throws(
      () => normalizeInviteEmail(bad),
      (error) => error.code === 'invalid_email',
      String(bad),
    );
  }
});

test('mail configuration is all-or-nothing and the unconfigured transport fails closed', async () => {
  assert.equal(loadMailConfig({}), null);
  assert.throws(() => loadMailConfig({ BETA_RESEND_API_KEY: 'k'.repeat(30) }));
  assert.throws(() => loadMailConfig({ BETA_MAIL_FROM: 'MetricTV <login@example.test>' }));
  assert.throws(() =>
    loadMailConfig({ BETA_RESEND_API_KEY: 'bad key!', BETA_MAIL_FROM: 'login@example.test' }),
  );
  assert.throws(() =>
    loadMailConfig({
      BETA_RESEND_API_KEY: 'k'.repeat(30),
      BETA_MAIL_FROM: 'a@b.test\r\nBcc: x@y.test',
    }),
  );
  const config = loadMailConfig({
    BETA_RESEND_API_KEY: 'k'.repeat(30),
    BETA_MAIL_FROM: 'MetricTV <login@example.test>',
  });
  assert.equal(config.sender, 'MetricTV <login@example.test>');

  assert.equal(unconfiguredTransport.configured, false);
  await assert.rejects(
    unconfiguredTransport.sendSignInCode({ recipient: 'a@example.test', code: '123456' }),
    (error) => error instanceof DeliveryError && error.code === 'delivery_not_configured',
  );
});

test('the Resend adapter sends one bounded HTTPS request and hides provider details (fake fetch)', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, body: null };
  };
  const transport = createResendTransport({
    apiKey: 'k'.repeat(30),
    sender: 'MetricTV <login@example.test>',
    fetchImpl: fakeFetch,
  });
  await transport.sendSignInCode({ recipient: 'owner@example.test', code: '654321' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${'k'.repeat(30)}`);
  const message = JSON.parse(calls[0].options.body);
  assert.deepEqual(message.to, ['owner@example.test']);
  assert.equal(message.from, 'MetricTV <login@example.test>');
  assert.match(message.text, /654321/);

  const rejecting = createResendTransport({
    apiKey: 'k'.repeat(30),
    sender: 'login@example.test',
    fetchImpl: async () => ({ ok: false, status: 403, body: null }),
  });
  await assert.rejects(
    rejecting.sendSignInCode({ recipient: 'owner@example.test', code: '654321' }),
    (error) => error.code === 'delivery_rejected' && !String(error.message).includes('654321'),
  );
  const unreachable = createResendTransport({
    apiKey: 'k'.repeat(30),
    sender: 'login@example.test',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED secret-detail');
    },
  });
  await assert.rejects(
    unreachable.sendSignInCode({ recipient: 'owner@example.test', code: '654321' }),
    (error) =>
      error.code === 'delivery_unreachable' && !String(error.message).includes('secret-detail'),
  );
});

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'admin.mjs'), ...args],
      { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test('operator CLI initializes once, invites exact emails, lists, revokes and prints no secrets', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const env = {
    BETA_DB_PATH: path.join(directory, 'private', 'beta.sqlite'),
    BETA_AUTH_SECRET: 'cli-secret-'.padEnd(48, 'x'),
    BETA_ORIGIN: 'http://127.0.0.1:4331',
  };

  const beforeInit = await runCli(['invite', 'owner@example.test'], env);
  assert.equal(beforeInit.code, 1);
  assert.match(beforeInit.stderr, /not_initialized/);

  const init = await runCli(['init'], env);
  assert.equal(init.code, 0, init.stderr);
  const secondInit = await runCli(['init'], env);
  assert.equal(secondInit.code, 1, 'a second init must not take over or reset the database');
  assert.match(secondInit.stderr, /already_exists/);

  const owners = await runCli(['owners'], env);
  assert.match(owners.stdout, /0 owner\(s\)/, 'init does not invite anyone');

  const invite = await runCli(['invite', 'Owner@Example.test'], env);
  assert.equal(invite.code, 0, invite.stderr);
  assert.match(invite.stdout, /owner@example\.test is now invited/);
  assert.match(invite.stdout, /No email was sent/);
  const again = await runCli(['invite', 'owner@example.test'], env);
  assert.match(again.stdout, /already invited/);

  const invalid = await runCli(['invite', 'not-an-email'], env);
  assert.equal(invalid.code, 1);

  const list = await runCli(['owners'], env);
  assert.match(list.stdout, /owner@example\.test\t[0-9a-f-]{36}/);
  assert.match(list.stdout, /1 owner\(s\)/);

  const revoke = await runCli(['revoke', 'owner@example.test'], env);
  assert.equal(revoke.code, 0, revoke.stderr);
  const unknown = await runCli(['revoke', 'nobody@example.test'], env);
  assert.equal(unknown.code, 1);

  for (const output of [init, invite, list, revoke]) {
    assert.equal((output.stdout + output.stderr).includes(env.BETA_AUTH_SECRET), false);
  }
});

/** Every IPv4 address of this machine that is not loopback. */
function externalIPv4Addresses() {
  const addresses = [];
  for (const interfaceAddresses of Object.values(os.networkInterfaces())) {
    for (const address of interfaceAddresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) addresses.push(address.address);
    }
  }
  return addresses;
}

/** True when something accepts a TCP connection at host:port before the timeout. */
function acceptsConnection(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (accepted) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const processOptions = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

test(
  'a real beta server process binds loopback, fails closed without mail and logs no secrets',
  processOptions,
  async (t) => {
    const directory = await makeTemporaryDirectory(t);
    // Ask the OS: a fixed random range collides with other tests' sockets and curl's ephemeral ports.
    const port = await findFreePort();
    const secret = 'proc-secret-'.padEnd(48, 'y');
    const env = {
      PATH: process.env.PATH,
      BETA_DB_PATH: path.join(directory, 'private', 'beta.sqlite'),
      BETA_AUTH_SECRET: secret,
      BETA_ORIGIN: `http://127.0.0.1:${port}`,
      BETA_PORT: String(port),
    };
    const init = await runCli(['init'], env);
    assert.equal(init.code, 0, init.stderr);
    assert.equal((await runCli(['invite', 'owner@example.test'], env)).code, 0);

    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'main.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const started = new Promise((resolve, reject) => {
      child.stdout.on('data', () => output.includes('Email delivery') && resolve());
      child.on('exit', () => reject(new Error(`server exited early: ${output}`)));
      setTimeout(() => reject(new Error('server did not start')), 15_000);
    });
    await started;
    assert.match(output, /NOT configured/);

    const origin = `http://127.0.0.1:${port}`;
    const page = await httpRequest({ origin, pathname: '/' });
    assert.equal(page.status, 200);
    const send = await httpRequest({
      origin,
      pathname: '/api/auth/email-otp/send-verification-otp',
      method: 'POST',
      headerLines: ['Content-Type: application/json', `Origin: ${origin}`],
      body: JSON.stringify({ email: 'owner@example.test', type: 'sign-in' }),
    });
    assert.equal(send.status, 503);
    assert.equal(send.json.error, 'delivery_not_configured');
    assert.equal(output.includes(secret), false);

    // Loopback only: the requests above reached 127.0.0.1, and none of this machine's other
    // addresses may accept a connection. (/proc/net/tcp would show the same, but only on Linux.)
    const externalAddresses = externalIPv4Addresses();
    if (externalAddresses.length === 0) {
      t.diagnostic('no non-loopback IPv4 address on this machine; all-interfaces probe skipped');
    }
    for (const address of externalAddresses) {
      assert.equal(await acceptsConnection(address, port), false, `never listens on ${address}`);
    }
  },
);

test('server start without an initialized database fails and creates nothing', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'private', 'beta.sqlite');
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(PROJECT_ROOT, 'server', 'main.mjs')],
      {
        env: {
          PATH: process.env.PATH,
          BETA_DB_PATH: databasePath,
          BETA_AUTH_SECRET: VALID_SECRET,
          BETA_ORIGIN: 'http://127.0.0.1:43999',
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }),
    );
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot start/);
  await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
});

// ---- Browser helpers (synthetic fetch) ----

function fakeFetchReturning(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('email and code parsing accept only plausible input', () => {
  assert.equal(parseEmail('  Owner@Example.TEST '), 'owner@example.test');
  for (const bad of ['', 'owner', 'a@b', 'a b@example.test', null, 5])
    assert.equal(parseEmail(bad), null);
  assert.equal(parseCode('123 456'), '123456');
  for (const bad of ['12345', '1234567', 'abcdef', '', null]) assert.equal(parseCode(bad), null);
});

test('client requests use fixed same-origin routes and keep the CSRF token out of bodies', async () => {
  const sent = fakeFetchReturning(200, { ok: true });
  assert.equal((await requestSignInCode('a@example.test', sent.fetchImpl)).ok, true);
  assert.equal(sent.calls[0].url, '/api/auth/email-otp/send-verification-otp');
  assert.deepEqual(JSON.parse(sent.calls[0].options.body), {
    email: 'a@example.test',
    type: 'sign-in',
  });
  assert.equal(sent.calls[0].options.credentials, 'same-origin');
  assert.equal(sent.calls[0].options.headers['X-CSRF-Token'], undefined);

  const verified = fakeFetchReturning(200, { ok: true });
  await verifySignInCode('a@example.test', '123456', verified.fetchImpl);
  assert.equal(verified.calls[0].url, '/api/auth/sign-in/email-otp');
  assert.deepEqual(JSON.parse(verified.calls[0].options.body), {
    email: 'a@example.test',
    otp: '123456',
  });

  const loggedOut = fakeFetchReturning(200, { ok: true });
  await signOut('token-value', loggedOut.fetchImpl);
  assert.equal(loggedOut.calls[0].url, '/api/auth/sign-out');
  assert.equal(loggedOut.calls[0].options.headers['X-CSRF-Token'], 'token-value');
  assert.equal(loggedOut.calls[0].options.body.includes('token-value'), false);

  const saved = fakeFetchReturning(200, { settings: {}, revision: 1 });
  await saveWorkspaceSettings(
    { csrfToken: 't', settings: { theme: 'dark' }, revision: 0 },
    saved.fetchImpl,
  );
  assert.deepEqual(JSON.parse(saved.calls[0].options.body), {
    settings: { theme: 'dark' },
    revision: 0,
  });
});

test('client reports delivery failure, rate limits and offline honestly', async () => {
  const unconfigured = fakeFetchReturning(503, { error: 'delivery_not_configured' });
  const result = await requestSignInCode('a@example.test', unconfigured.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_not_configured');
  assert.match(messageForError(result.error), /cannot send sign-in codes/);
  assert.match(messageForError(result.error), /No code was sent/);

  const offline = await requestSignInCode('a@example.test', async () => {
    throw new TypeError('network down');
  });
  assert.equal(offline.error, 'offline');
  assert.equal(messageForError('unknown-code'), 'Something went wrong. Please try again.');
  for (const message of Object.values(ERROR_MESSAGES)) assert.ok(message.length > 10);
});

test('session loading separates signed-out from failure', async () => {
  assert.deepEqual(
    await loadOwnerSession(fakeFetchReturning(401, { error: 'unauthenticated' }).fetchImpl),
    {
      status: 'signed-out',
    },
  );
  const failure = await loadOwnerSession(
    fakeFetchReturning(500, { error: 'server_error' }).fetchImpl,
  );
  assert.equal(failure.status, 'error');
  const ok = await loadOwnerSession(
    fakeFetchReturning(200, { owner: { email: 'a@example.test' } }).fetchImpl,
  );
  assert.equal(ok.status, 'signed-in');
});

const SESSION_VIEW = {
  owner: { email: 'owner@example.test' },
  workspace: { name: 'My MetricTV', revision: 3, settings: { period: 'month', theme: 'dark' } },
  storeConnection: { state: 'setup_required', canConnect: false },
  csrfToken: 'abc',
};

test('sign-in view escapes input and never shows a fake success', () => {
  const emailStep = renderSignIn({
    step: 'email',
    email: '"><img src=x onerror=alert(1)>',
    message:
      'This beta cannot send sign-in codes yet because email delivery is not set up. No code was sent.',
    tone: 'error',
  });
  assert.equal(emailStep.includes('<img src=x'), false);
  assert.match(emailStep, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(emailStep, /role="alert"/);
  assert.match(emailStep, /No code was sent/);
  assert.match(emailStep, /Email me a sign-in code/);

  const codeStep = renderSignIn({
    step: 'code',
    email: '<b>x</b>@example.test',
    message: '',
    tone: 'info',
  });
  assert.equal(codeStep.includes('<b>'), false);
  assert.match(codeStep, /autocomplete="one-time-code"/);
});

test('owner view shows the honest empty state, escapes values and offers sign out', () => {
  const html = renderOwner({
    session: { ...SESSION_VIEW, owner: { email: '"><script>alert(1)</script>@example.test' } },
    message: '',
    tone: 'info',
    screens: { status: 'ready', items: [] },
    confirmRevokeId: '',
    screenMessage: '',
    screenTone: 'info',
  });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /data-store-state="loading"/);
  assert.match(html, /data-action="sign-out"/);
  assert.match(html, /<option value="month" selected>/);
  assert.match(html, /<option value="dark" selected>/);
  assert.equal(
    /\$[0-9]|class="metric-value"/i.test(html),
    false,
    'no metrics or fictional figures',
  );
  assert.equal(html.includes(SESSION_VIEW.csrfToken), false, 'the CSRF token is never rendered');
});
