// Shared scenario setup for the beta Shopify tests. The beta server, Better Auth, SQLite, the
// grant files and the Shopify OAuth/collector code are all real; only the outbound Shopify
// transport is the synthetic fixture in synthetic-shopify.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadBetaShopifyConfig } from '../server/shopify/config.mjs';
import {
  createBetaEnvironment,
  createBrowser,
  signInOwner,
  startBetaServer,
} from './beta-helpers.mjs';
import {
  SYNTHETIC_CLIENT_ID,
  SYNTHETIC_CLIENT_SECRET,
  SYNTHETIC_STORE,
  createSyntheticShopify,
  signedCallbackQuery,
} from './synthetic-shopify.mjs';

export const ALICE = 'alice@example.test';
export const BOB = 'bob@example.test';
export const CALLBACK_PATH = '/auth/beta/shopify/callback';
export { SYNTHETIC_STORE, signedCallbackQuery };

export async function waitFor(check, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function shopifyEnvironment({ tokenDirectory, key, ownerEmail = ALICE }) {
  return {
    BETA_SHOPIFY_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    BETA_SHOPIFY_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    BETA_SHOPIFY_ENCRYPTION_KEY: key,
    BETA_SHOPIFY_TOKEN_DIR: tokenDirectory,
    BETA_SHOPIFY_ALLOWED_STORE: SYNTHETIC_STORE,
    BETA_SHOPIFY_OWNER_EMAIL: ownerEmail,
  };
}

/**
 * Two invited owners (the first is the pilot owner), a running beta server and a synthetic
 * Shopify. `clock.offsetMs` moves only the service's clock (token expiry, attempt expiry).
 */
export async function createScenario(t, { invites = [ALICE, BOB], ownerEmail = ALICE } = {}) {
  const environment = await createBetaEnvironment(t, { invites });
  const tokenDirectory = path.join(environment.directory, 'grants');
  const clock = { offsetMs: 0 };
  const now = () => Date.now() + clock.offsetMs;
  const upstream = createSyntheticShopify({ now });
  const scenario = {
    environment,
    tokenDirectory,
    upstream,
    clock,
    key: crypto.randomBytes(32).toString('base64'),
    handle: null,
    ownerEmail,
  };

  async function start({ ownerEmail: owner = scenario.ownerEmail, key = scenario.key } = {}) {
    const shopifyConfig = loadBetaShopifyConfig(
      shopifyEnvironment({ tokenDirectory, key, ownerEmail: owner }),
    );
    scenario.handle = await startBetaServer(t, environment, {
      shopifyConfig,
      fetchImpl: upstream.fetchImpl,
      now,
    });
    return scenario.handle;
  }

  scenario.restart = async (options) => {
    await scenario.handle.close();
    return start(options);
  };
  scenario.signIn = (email) => signInOwner(scenario.handle, email);
  scenario.grantFiles = async () => {
    try {
      const names = await fs.readdir(tokenDirectory);
      return names.filter((name) => name.endsWith('.grant.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  scenario.workspaceId = (email) =>
    scenario.handle.database
      .prepare(
        `SELECT workspace.id AS id FROM workspace
         JOIN "user" ON "user".id = workspace.owner_user_id WHERE "user".email = ?`,
      )
      .get(email).id;
  scenario.link = (email) =>
    scenario.handle.database
      .prepare('SELECT * FROM workspace_store WHERE workspace_id = ?')
      .get(scenario.workspaceId(email)) ?? null;
  scenario.openAttempts = () =>
    scenario.handle.database.prepare('SELECT COUNT(*) AS count FROM shopify_oauth_attempt').get()
      .count;

  await start();
  return scenario;
}

/** Owner starts authorization; returns the state Shopify would echo back. */
export async function beginAuthorization(browser, store = SYNTHETIC_STORE) {
  await browser.loadSession();
  const started = await browser.startShopify(store);
  if (started.status !== 200) throw new Error(`start failed with ${started.status}`);
  const state = new URL(started.json.authorizationUrl).searchParams.get('state');
  return { started, state };
}

/** Full successful connection through the real routes; returns the callback response. */
export async function connectOwner(browser, store = SYNTHETIC_STORE) {
  const { state } = await beginAuthorization(browser, store);
  const callback = await browser.shopifyCallback(signedCallbackQuery({ state }));
  if (callback.headers.get('location') !== '/?shopify=connected') {
    throw new Error(`connection failed: ${callback.headers.get('location')}`);
  }
  return callback;
}

/** Waits until the owner's snapshot exists, then returns the status response. */
export async function waitForSnapshot(browser) {
  let latest = null;
  await waitFor(
    async () => {
      latest = await browser.shopifyStatus();
      return latest.json?.snapshot ?? null;
    },
    { label: 'first snapshot' },
  );
  return latest;
}

/** Pairs a TV to the signed-in owner's workspace and returns the TV browser. */
export async function pairTv(handle, ownerBrowser, name = 'Office TV') {
  const tv = createBrowser(handle.origin);
  const challenge = await tv.createTvChallenge();
  const code = challenge.json.code.replace('-', '');
  const approved = await ownerBrowser.pairScreen(code, name);
  if (approved.status !== 200) throw new Error(`pairing failed with ${approved.status}`);
  const exchanged = await tv.exchangePairing();
  if (exchanged.status !== 200) throw new Error(`exchange failed with ${exchanged.status}`);
  return tv;
}
