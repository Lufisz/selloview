// Shopify connection settings: loading and validation, and a real server process that refuses
// partial settings and starts with complete ones. Data here is SYNTHETIC and labelled as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadShopifyConfig } from '../../server/shopify/config.mjs';
import {
  curlAvailable,
  findFreePort,
  httpRequest,
  makeTemporaryDirectory,
} from '../helpers/app-server.mjs';
import { SYNTHETIC_CLIENT_SECRET, SYNTHETIC_STORE } from '../helpers/synthetic-shopify.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const OWNER = 'owner@example.test';
const KEY = crypto.randomBytes(32).toString('base64');

function validEnvironment(directory) {
  return {
    METRICTV_SHOPIFY_CLIENT_ID: 'synthetic_client_id_0001',
    METRICTV_SHOPIFY_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    METRICTV_SHOPIFY_ENCRYPTION_KEY: KEY,
    METRICTV_SHOPIFY_TOKEN_DIR: directory,
    METRICTV_SHOPIFY_ALLOWED_STORE: SYNTHETIC_STORE,
    METRICTV_SHOPIFY_OWNER_EMAIL: 'Owner@Example.test',
  };
}

// ---- configuration ------------------------------------------------------------------------

test('no Shopify settings at all is a safe setup-required state', () => {
  assert.deepEqual({ ...loadShopifyConfig({}) }, { status: 'setup_required' });
  assert.deepEqual(
    { ...loadShopifyConfig({ METRICTV_SHOPIFY_CLIENT_ID: '' }) },
    { status: 'setup_required' },
  );
});

test('complete settings load; partial or malformed settings fail closed without details', () => {
  const directory = path.join(path.sep, 'var', 'lib', 'metrictv-test-grants');
  const config = loadShopifyConfig(validEnvironment(directory));
  assert.equal(config.status, 'ready');
  assert.equal(config.ownerEmail, 'owner@example.test', 'the owner address is normalized');
  assert.equal(config.store, SYNTHETIC_STORE);
  assert.equal(config.clientSecret, SYNTHETIC_CLIENT_SECRET);
  const serialized = JSON.stringify(config) + String(Object.keys(config));
  for (const secret of [SYNTHETIC_CLIENT_SECRET, KEY, directory, 'synthetic_client_id_0001']) {
    assert.equal(serialized.includes(secret), false, 'secrets are not enumerable');
  }

  const good = validEnvironment(directory);
  const bad = [];
  for (const name of Object.keys(good)) bad.push({ ...good, [name]: '' });
  bad.push(
    { ...good, METRICTV_SHOPIFY_CLIENT_ID: 'short' },
    { ...good, METRICTV_SHOPIFY_CLIENT_SECRET: 'has space in it, not allowed' },
    { ...good, METRICTV_SHOPIFY_ENCRYPTION_KEY: crypto.randomBytes(16).toString('base64') },
    { ...good, METRICTV_SHOPIFY_ENCRYPTION_KEY: ` ${KEY}` },
    { ...good, METRICTV_SHOPIFY_ENCRYPTION_KEY: KEY.replace(/=$/, '') },
    { ...good, METRICTV_SHOPIFY_ENCRYPTION_KEY: 12345 },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: 'relative/grants' },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: `${directory}/` },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: `${directory}/../x` },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: path.resolve(PROJECT_ROOT, 'grants') },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: path.resolve(PROJECT_ROOT, 'public') },
    // A folder whose name merely starts with ".." is still inside the project, not above it.
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: path.resolve(PROJECT_ROOT, '..tokens') },
    { ...good, METRICTV_SHOPIFY_TOKEN_DIR: path.sep },
    { ...good, METRICTV_SHOPIFY_ALLOWED_STORE: 'Store.myshopify.com' },
    { ...good, METRICTV_SHOPIFY_ALLOWED_STORE: 'evil.example.com' },
    { ...good, METRICTV_SHOPIFY_ALLOWED_STORE: `https://${SYNTHETIC_STORE}` },
    { ...good, METRICTV_SHOPIFY_OWNER_EMAIL: 'not an email' },
  );
  for (const env of bad) {
    assert.throws(
      () => loadShopifyConfig(env),
      (error) =>
        error.code === 'invalid_connection_config' &&
        !String(error.message).includes(SYNTHETIC_CLIENT_SECRET),
    );
  }
});

// ---- the real process ----------------------------------------------------------------------------

const processOptions = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

function runNode(args, env, { until } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timed out: ${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += chunk;
      if (until && output.includes(until)) {
        clearTimeout(timer);
        resolve({ child, output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!until) resolve({ code, output });
    });
  });
}

test(
  'the real server process refuses partial Shopify settings and starts with complete ones',
  processOptions,
  async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const port = await findFreePort();
    const secret = 'proc-secret-'.padEnd(48, 'z');
    const base = {
      PATH: process.env.PATH,
      METRICTV_DB_PATH: path.join(directory, 'private', 'metrictv.sqlite'),
      METRICTV_AUTH_SECRET: secret,
      METRICTV_ORIGIN: `http://127.0.0.1:${port}`,
      METRICTV_PORT: String(port),
    };
    const init = await runNode([path.join(PROJECT_ROOT, 'scripts', 'admin.mjs'), 'init'], base);
    assert.equal(init.code, 0, init.output);
    const server = path.join(PROJECT_ROOT, 'server', 'main.mjs');

    const partial = await runNode([server], {
      ...base,
      METRICTV_SHOPIFY_CLIENT_ID: 'synthetic_client_id_0001',
      METRICTV_SHOPIFY_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    });
    assert.equal(partial.code, 1, 'incomplete settings stop the server');
    assert.match(partial.output, /invalid_connection_config/);
    assert.equal(partial.output.includes(SYNTHETIC_CLIENT_SECRET), false);
    assert.equal(partial.output.includes('synthetic_client_id_0001'), false);

    const grants = path.join(directory, 'grants');
    const complete = {
      ...base,
      ...validEnvironment(grants),
      METRICTV_SHOPIFY_OWNER_EMAIL: OWNER,
    };
    const running = await runNode([server], complete, { until: 'Shopify store connection' });
    t.after(() => running.child.kill('SIGKILL'));
    assert.match(running.output, /Shopify store connection: configured/);
    for (const secretValue of [SYNTHETIC_CLIENT_SECRET, KEY, grants]) {
      assert.equal(running.output.includes(secretValue), false);
    }
    const anonymous = await httpRequest({
      origin: base.METRICTV_ORIGIN,
      pathname: '/api/shopify',
    });
    assert.equal(anonymous.status, 401, 'owner session required');
    const callback = await httpRequest({
      origin: base.METRICTV_ORIGIN,
      pathname: '/auth/beta/shopify/callback?state=x',
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/app?shopify=failed');
  },
);
