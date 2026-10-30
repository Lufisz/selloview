// Server configuration, private database safety, mail transport, the operator CLI and a real server
// process. Provider calls use a fake fetch: nothing leaves the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '../../server/config.mjs';
import {
  PrivateDatabaseError,
  createPrivateDatabaseFile,
  openPrivateDatabase,
  parseDatabasePath,
} from '../../server/accounts/private-database.mjs';
import {
  DeliveryError,
  createResendTransport,
  loadMailConfig,
  unconfiguredTransport,
} from '../../server/accounts/mail-transport.mjs';
import { normalizeInviteEmail } from '../../server/accounts/accounts.mjs';
import {
  curlAvailable,
  findFreePort,
  httpRequest,
  makeTemporaryDirectory,
} from '../helpers/app-server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALID_SECRET = 'S'.repeat(40);
const GOOD_ENV = {
  METRICTV_DB_PATH: '/var/tmp/metrictv-private/metrictv.sqlite',
  METRICTV_AUTH_SECRET: VALID_SECRET,
  METRICTV_ORIGIN: 'https://metrictv.example.test',
};

test('configuration rejects unsafe or missing values instead of defaulting', () => {
  const config = loadServerConfig(GOOD_ENV);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.origin, 'https://metrictv.example.test');
  assert.equal(config.port, 4330);

  const badChanges = [
    { METRICTV_DB_PATH: undefined },
    { METRICTV_DB_PATH: 'relative/metrictv.sqlite' },
    { METRICTV_DB_PATH: '/var/tmp/../tmp/metrictv.sqlite' },
    { METRICTV_DB_PATH: '/var/tmp/beta.db' },
    { METRICTV_DB_PATH: path.join(PROJECT_ROOT, 'state', 'metrictv.sqlite') },
    { METRICTV_AUTH_SECRET: 'short' },
    { METRICTV_AUTH_SECRET: undefined },
    { METRICTV_ORIGIN: undefined },
    { METRICTV_ORIGIN: 'http://metrictv.example.test' },
    { METRICTV_ORIGIN: 'https://metrictv.example.test/' },
    { METRICTV_ORIGIN: 'https://metrictv.example.test/path' },
    { METRICTV_ORIGIN: 'https://user:pass@metrictv.example.test' },
    { METRICTV_PORT: '0' },
    { METRICTV_PORT: 'abc' },
    { METRICTV_TRUSTED_IP_HEADER: 'bad header' },
  ];
  for (const change of badChanges) {
    assert.throws(
      () => loadServerConfig({ ...GOOD_ENV, ...change }),
      Error,
      JSON.stringify(change),
    );
  }
  assert.equal(
    loadServerConfig({ ...GOOD_ENV, METRICTV_ORIGIN: 'http://127.0.0.1:4330' }).origin,
    'http://127.0.0.1:4330',
  );
});

// The settings were called BETA_* before the project went public. A stale environment file has to
// stop the server: a half-renamed configuration would run with the old half silently ignored.
const RENAMED_SETTINGS = [
  ['BETA_DB_PATH', 'METRICTV_DB_PATH'],
  ['BETA_AUTH_SECRET', 'METRICTV_AUTH_SECRET'],
  ['BETA_ORIGIN', 'METRICTV_ORIGIN'],
  ['BETA_PORT', 'METRICTV_PORT'],
  ['BETA_TRUSTED_IP_HEADER', 'METRICTV_TRUSTED_IP_HEADER'],
  ['BETA_RESEND_API_KEY', 'METRICTV_RESEND_API_KEY'],
  ['BETA_MAIL_FROM', 'METRICTV_MAIL_FROM'],
  ['BETA_SELF_REGISTRATION', 'METRICTV_SELF_REGISTRATION'],
  ['BETA_REGISTRATION_MAX_ACCOUNTS', 'METRICTV_REGISTRATION_MAX_ACCOUNTS'],
  ['BETA_SHOPIFY_CLIENT_ID', 'METRICTV_SHOPIFY_CLIENT_ID'],
  ['BETA_SHOPIFY_CLIENT_SECRET', 'METRICTV_SHOPIFY_CLIENT_SECRET'],
  ['BETA_SHOPIFY_ENCRYPTION_KEY', 'METRICTV_SHOPIFY_ENCRYPTION_KEY'],
  ['BETA_SHOPIFY_TOKEN_DIR', 'METRICTV_SHOPIFY_TOKEN_DIR'],
  ['BETA_SHOPIFY_ALLOWED_STORE', 'METRICTV_SHOPIFY_ALLOWED_STORE'],
  ['BETA_SHOPIFY_OWNER_EMAIL', 'METRICTV_SHOPIFY_OWNER_EMAIL'],
];

test('a leftover BETA_ setting is refused with its replacement named, and its value is never printed', () => {
  const leftoverValue = 'leftover-value-that-must-not-be-printed';
  for (const [oldName, newName] of RENAMED_SETTINGS) {
    assert.throws(
      () => loadServerConfig({ ...GOOD_ENV, [oldName]: leftoverValue }),
      (error) =>
        error.message.includes(`${oldName} is now ${newName}`) &&
        !error.message.includes(leftoverValue),
      oldName,
    );
  }
});

test('a leftover setting counts even when empty, all of them are listed, and unknown names are left alone', () => {
  assert.throws(
    () =>
      loadServerConfig({
        ...GOOD_ENV,
        BETA_PORT: '',
        BETA_ORIGIN: '',
        BETA_SHOPIFY_TOKEN_DIR: '',
      }),
    (error) =>
      error.message.includes('BETA_PORT is now METRICTV_PORT') &&
      error.message.includes('BETA_ORIGIN is now METRICTV_ORIGIN') &&
      error.message.includes('BETA_SHOPIFY_TOKEN_DIR is now METRICTV_SHOPIFY_TOKEN_DIR'),
  );
  // A name this project never had is not a renamed setting.
  assert.equal(loadServerConfig({ ...GOOD_ENV, BETA_UNRELATED: 'x' }).port, 4330);
});

test('the private database is created once, private, outside the project, and never auto-created', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'nested', 'metrictv.sqlite');
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
  assert.throws(() => loadMailConfig({ METRICTV_RESEND_API_KEY: 'k'.repeat(30) }));
  assert.throws(() => loadMailConfig({ METRICTV_MAIL_FROM: 'MetricTV <login@example.test>' }));
  assert.throws(() =>
    loadMailConfig({
      METRICTV_RESEND_API_KEY: 'bad key!',
      METRICTV_MAIL_FROM: 'login@example.test',
    }),
  );
  assert.throws(() =>
    loadMailConfig({
      METRICTV_RESEND_API_KEY: 'k'.repeat(30),
      METRICTV_MAIL_FROM: 'a@b.test\r\nBcc: x@y.test',
    }),
  );
  const config = loadMailConfig({
    METRICTV_RESEND_API_KEY: 'k'.repeat(30),
    METRICTV_MAIL_FROM: 'MetricTV <login@example.test>',
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
    METRICTV_DB_PATH: path.join(directory, 'private', 'metrictv.sqlite'),
    METRICTV_AUTH_SECRET: 'cli-secret-'.padEnd(48, 'x'),
    METRICTV_ORIGIN: 'http://127.0.0.1:4331',
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
    assert.equal((output.stdout + output.stderr).includes(env.METRICTV_AUTH_SECRET), false);
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
  'a real server process binds loopback, fails closed without mail and logs no secrets',
  processOptions,
  async (t) => {
    const directory = await makeTemporaryDirectory(t);
    // Ask the OS: a fixed random range collides with other tests' sockets and curl's ephemeral ports.
    const port = await findFreePort();
    const secret = 'proc-secret-'.padEnd(48, 'y');
    const env = {
      PATH: process.env.PATH,
      METRICTV_DB_PATH: path.join(directory, 'private', 'metrictv.sqlite'),
      METRICTV_AUTH_SECRET: secret,
      METRICTV_ORIGIN: `http://127.0.0.1:${port}`,
      METRICTV_PORT: String(port),
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

/** Runs the server entry point until it exits (it must, because the settings are wrong). */
function runServerOnce(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(PROJECT_ROOT, 'server', 'main.mjs')],
      { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }),
    );
  });
}

test('server start without an initialized database fails and creates nothing', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'private', 'metrictv.sqlite');
  const result = await runServerOnce({
    METRICTV_DB_PATH: databasePath,
    METRICTV_AUTH_SECRET: VALID_SECRET,
    METRICTV_ORIGIN: 'http://127.0.0.1:43999',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot start/);
  await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
});

test('the server and the admin CLI refuse a leftover BETA_ setting before touching anything', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'private', 'metrictv.sqlite');
  const env = {
    METRICTV_DB_PATH: databasePath,
    METRICTV_AUTH_SECRET: VALID_SECRET,
    METRICTV_ORIGIN: 'http://127.0.0.1:43999',
    BETA_PORT: '43999',
  };
  const server = await runServerOnce(env);
  const admin = await runCli(['init'], env);
  for (const result of [server, admin]) {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BETA_PORT is now METRICTV_PORT/);
    assert.equal(result.stderr.includes(VALID_SECRET), false);
  }
  await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' }, 'nothing was created');
});

test('the admin CLI names the npm command to run when it gets an unknown command', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const result = await runCli(['frobnicate'], {
    METRICTV_DB_PATH: path.join(directory, 'private', 'metrictv.sqlite'),
    METRICTV_AUTH_SECRET: VALID_SECRET,
    METRICTV_ORIGIN: 'http://127.0.0.1:43999',
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /npm run admin -- init \| migrate \| invite <email>/);
});
