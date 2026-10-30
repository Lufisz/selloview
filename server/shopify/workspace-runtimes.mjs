// What the server keeps in memory for each linked store: its grant (an encrypted file and the manager
// that renews it), its figures (the snapshot cache) and its logo. A runtime is created on first use
// and kept until the store is disconnected.
//
// This is also the one place that decides when stores refresh. Nothing here runs on a timer: a
// store is refreshed when someone reads it and its figures are due, so stores nobody is watching
// cost nothing.
import path from 'node:path';
import { createAdminRunner } from './admin-runner.mjs';
import { createGrantManager } from './grant-manager.mjs';
import { setLinkState } from './links.mjs';
import { createShopSnapshotCache, toSafeErrorCode } from './snapshot-cache.mjs';
import { createTokenStore } from './token-store.mjs';
import { logEvent } from '../log.mjs';

const WORKSPACE_ID_PATTERN = /^[0-9a-f-]{36}$/;
// ceiling: 2 refreshes at once, which keeps about 60 stores fresh if each refresh takes 4 s,
// upgrade: raise it when stores turn stale while the server is otherwise idle
const MAX_CONCURRENT_REFRESHES = 2;
// A logo rarely changes: check once a day, and retry sooner when a read failed.
const LOGO_RECHECK_MS = 24 * 60 * 60 * 1000;
const LOGO_RETRY_MS = 30 * 60 * 1000;

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {{store: string, clientId: string, tokenDirectory: string, encryptionKey: Buffer}} options.config
 *   From loadShopifyConfig, once it is ready.
 * @param {object} options.shopify  Official SDK client from createShopifySdk.
 * @param {Function} options.boundedFetch  Transport from createShopifyFetch for the store.
 * @param {Function} options.fetchImpl
 * @param {() => number} options.now
 * @param {number} options.refreshIntervalMs  How long figures count as current.
 * @param {Function} options.fetchLogo
 */
export function createWorkspaceRuntimes({
  database,
  config,
  shopify,
  boundedFetch,
  fetchImpl,
  now,
  refreshIntervalMs,
  fetchLogo,
}) {
  // ceiling: a runtime stays in memory until its store is disconnected (about 20 KB plus a logo of
  // up to 1 MiB), upgrade: evict idle runtimes once thousands of stores are linked
  const runtimes = new Map();
  let activeRefreshes = 0;

  function handleGrantChange(runtime, { state }) {
    // Any credential change makes cached figures untrustworthy; late collector results from
    // before the change are dropped by the cache's generation counter.
    runtime.cache.clear();
    runtime.lastTriggeredAt = null;
    if (state === 'reconnect_required') {
      setLinkState(database, {
        workspaceId: runtime.workspaceId,
        state: 'reconnect_required',
        nowMs: now(),
      });
    }
    if (state === 'connected') maybeRefresh(runtime);
  }

  /** The runtime of a workspace, created on first use. Only ids shaped like ours become file names. */
  function forWorkspace(workspaceId) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('invalid workspace id');
    const existing = runtimes.get(workspaceId);
    if (existing) return existing;
    const tokenStore = createTokenStore({
      filePath: path.join(config.tokenDirectory, `${workspaceId}.grant.json`),
      key: config.encryptionKey,
      clientId: config.clientId,
      store: config.store,
      workspaceId,
    });
    const runtime = {
      workspaceId,
      lastTriggeredAt: null,
      logo: { image: null, nextCheckAt: 0, inflight: false },
    };
    runtime.manager = createGrantManager({
      tokenStore,
      shopify,
      boundedFetch,
      store: config.store,
      clientId: config.clientId,
      now,
      // Dropped first, so a refresh that fails because its credentials just vanished is ignored.
      onDiscard: () => runtime.cache.clear(),
      onChange: (event) => handleGrantChange(runtime, event),
    });
    runtime.cache = createShopSnapshotCache({
      store: config.store,
      run: createAdminRunner({ store: config.store, connection: runtime.manager, fetchImpl }),
      now,
      onFailure: (error) => {
        logEvent('refresh_failed', {
          workspaceId,
          code: toSafeErrorCode(error),
          error: error?.name ?? 'Error',
        });
      },
    });
    runtimes.set(workspaceId, runtime);
    return runtime;
  }

  /** Drops a workspace's runtime once its store is disconnected. */
  function forget(workspaceId) {
    runtimes.delete(workspaceId);
  }

  /** Background collection: one at a time per workspace, rate-spaced, globally bounded. */
  function maybeRefresh(runtime) {
    const isDue =
      runtime.lastTriggeredAt === null || now() - runtime.lastTriggeredAt >= refreshIntervalMs;
    if (!isDue || runtime.cache.inflight) return;
    if (activeRefreshes >= MAX_CONCURRENT_REFRESHES) return;
    runtime.lastTriggeredAt = now();
    activeRefreshes += 1;
    runtime.cache.refresh().finally(() => {
      activeRefreshes -= 1;
    });
  }

  /** Keeps the store logo current in the background. A failed read keeps the last good logo. */
  function maybeRefreshLogo(runtime) {
    const { logo } = runtime;
    if (logo.inflight || now() < logo.nextCheckAt) return;
    logo.inflight = true;
    fetchLogo({ store: config.store, fetchImpl })
      .then((image) => {
        logo.image = image;
        logo.nextCheckAt = now() + LOGO_RECHECK_MS;
      })
      .catch(() => {
        logo.nextCheckAt = now() + LOGO_RETRY_MS;
      })
      .finally(() => {
        logo.inflight = false;
      });
  }

  return { forWorkspace, forget, maybeRefresh, maybeRefreshLogo };
}
