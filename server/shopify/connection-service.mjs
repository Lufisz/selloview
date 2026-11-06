// Workspace-scoped Shopify connection: what a workspace may see of its store, and how it leaves.
//
// One shared official-SDK client; one encrypted grant file, grant manager and snapshot cache per
// linked workspace (workspace-runtimes.mjs); one flow that connects a store (connect-flow.mjs).
// Everything that touches a store starts from a workspace the server derived from a verified owner
// session or display session. A shop name in a request is never enough.
//
// The configuration (SELLOVIEW_SHOPIFY_*) restricts which owner and which exact store may be linked;
// the data model stays workspace-bound so lifting that restriction later does not change any
// isolation rule.
import { createConnectFlow } from './connect-flow.mjs';
import { createShopifyFetch } from './http.mjs';
import { createShopifySdk } from './sdk.mjs';
import { REFRESH_MS } from './snapshot-cache.mjs';
import { createWorkspaceRuntimes } from './workspace-runtimes.mjs';
import { fetchShopLogo } from './shop-logo.mjs';
import {
  discardAttemptsForWorkspace,
  readLink,
  readWorkspaceOwnerEmail,
  removeLink,
} from './links.mjs';

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const STATES_THAT_MAY_CONNECT = new Set(['not_connected', 'connected', 'reconnect_required']);

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {{status: string}} options.config  From loadShopifyConfig.
 * @param {string} options.origin  Exact public origin.
 */
export function createShopifyService({
  database,
  config,
  origin,
  fetchImpl = fetch,
  now = Date.now,
  refreshIntervalMs = REFRESH_MS,
  fetchLogo = fetchShopLogo,
}) {
  const isReady = config.status === 'ready';

  let shopify = null;
  let boundedFetch = null;
  if (isReady) {
    shopify = createShopifySdk({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      origin,
    });
    boundedFetch = createShopifyFetch({
      store: config.store,
      fetchImpl,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    });
  }

  function isAllowedOwner(email) {
    return isReady && typeof email === 'string' && email.toLowerCase() === config.ownerEmail;
  }

  const runtimes = createWorkspaceRuntimes({
    database,
    config,
    shopify,
    boundedFetch,
    fetchImpl,
    now,
    refreshIntervalMs,
    fetchLogo,
  });
  const connectFlow = createConnectFlow({
    database,
    config,
    origin,
    isReady,
    isAllowedOwner,
    shopify,
    boundedFetch,
    runtimes,
    now,
  });

  /**
   * The single decision about what a workspace may see. Returns { state, runtime? }. A runtime is
   * returned only for a workspace that is linked to the configured store, belongs to the allowed
   * owner, and still holds a usable grant.
   */
  async function resolve(workspaceId, ownerEmail) {
    if (!isReady) return { state: 'setup_required' };
    if (!isAllowedOwner(ownerEmail)) return { state: 'owner_not_allowed' };
    const link = readLink(database, workspaceId);
    if (!link) return { state: 'not_connected' };
    if (link.shop !== config.store) return { state: 'owner_not_allowed' };
    if (link.state === 'reconnect_required') return { state: 'reconnect_required' };
    const runtime = runtimes.forWorkspace(workspaceId);
    const grantState = await runtime.manager.currentState();
    // A missing or unreadable grant file is not "connected", whatever the table says.
    if (grantState !== 'connected') return { state: 'reconnect_required' };
    return { state: 'connected', runtime };
  }

  function describeConnection(resolved, ownerEmail) {
    const { state, runtime } = resolved;
    const connection = { state };
    if (isAllowedOwner(ownerEmail)) {
      connection.store = config.store;
      connection.canConnect = STATES_THAT_MAY_CONNECT.has(state);
    } else {
      connection.canConnect = false;
    }
    if (runtime) {
      runtimes.maybeRefresh(runtime);
      connection.sync = runtime.cache.sync();
    }
    return connection;
  }

  return {
    configured: isReady,
    isAllowedOwner,

    /** Owner dashboard: connection summary plus the full safe snapshot when one exists. */
    async inspect(workspaceId, ownerEmail) {
      const resolved = await resolve(workspaceId, ownerEmail);
      const connection = describeConnection(resolved, ownerEmail);
      let snapshot = null;
      if (resolved.runtime?.cache.snapshot) {
        snapshot = { ...resolved.runtime.cache.snapshot, sync: resolved.runtime.cache.sync() };
      }
      return { connection, snapshot };
    },

    /** TV: the workspace's state and its cached full snapshot; the caller projects it. */
    async inspectForDisplay(workspaceId) {
      const ownerEmail = readWorkspaceOwnerEmail(database, workspaceId);
      const resolved = await resolve(workspaceId, ownerEmail);
      const { runtime } = resolved;
      if (!runtime) return { state: resolved.state, snapshot: null, sync: null };
      runtimes.maybeRefresh(runtime);
      runtimes.maybeRefreshLogo(runtime);
      const sync = runtime.cache.sync();
      const logoVersion = runtime.logo.image ? runtime.logo.image.version : null;
      return { state: resolved.state, snapshot: runtime.cache.snapshot, sync, logoVersion };
    },

    /** TV: the cached logo image of a connected workspace, or null. Never fetches. */
    async logoForDisplay(workspaceId) {
      const ownerEmail = readWorkspaceOwnerEmail(database, workspaceId);
      const { runtime } = await resolve(workspaceId, ownerEmail);
      return runtime ? runtime.logo.image : null;
    },

    begin: connectFlow.begin,
    complete: connectFlow.complete,
    clearingCookies: connectFlow.clearingCookies,

    /** Local disconnect: link, pending attempts, cached figures and the grant file all go. */
    async disconnect({ workspaceId, ownerEmail }) {
      if (!isReady) return { status: 'setup_required' };
      if (!isAllowedOwner(ownerEmail)) return { status: 'owner_not_allowed' };
      discardAttemptsForWorkspace(database, workspaceId);
      removeLink(database, workspaceId);
      const runtime = runtimes.forWorkspace(workspaceId);
      let removalFailed = false;
      try {
        await runtime.manager.disconnect();
      } catch {
        removalFailed = true;
      }
      runtime.cache.clear();
      runtimes.forget(workspaceId);
      return { status: removalFailed ? 'disconnect_failed' : 'ok' };
    },
  };
}
