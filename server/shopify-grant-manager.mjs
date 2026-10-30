// One Shopify offline grant: load, renew, revoke and replace it without races.
//
// Each linked workspace owns one of these. All ordering guarantees come from the token store's
// epochs (see shopify-token-store.mjs): a refresh or exchange that finishes after a disconnect or
// reconnect cannot restore old credentials.
import { ShopifyError } from './shopify.mjs';
import { grantFromSession, runWithBoundedFetch } from './shopify-sdk.mjs';

// Renew the 1 hour access token five minutes early so a request never races its expiry.
const REFRESH_EARLY_MS = 5 * 60_000;
const PERMANENT_REFRESH_STATUSES = new Set([400, 401, 403, 404, 410]);

/**
 * @param {object} options
 * @param {ReturnType<import('./shopify-token-store.mjs').createTokenStore>} options.tokenStore
 * @param {object} options.shopify  Official SDK client from createShopifySdk.
 * @param {Function} options.boundedFetch  Transport from createShopifyFetch for this store.
 * @param {string} options.store
 * @param {string} options.clientId
 * @param {() => number} [options.now]
 * @param {(event: {state: string}) => Promise<void>|void} [options.onChange]
 *   Called after the grant changes; listeners clear caches. A throwing listener is ignored.
 * @param {() => void} [options.onDiscard]  Called first whenever credentials are dropped.
 */
export function createGrantManager({
  tokenStore,
  shopify,
  boundedFetch,
  store,
  clientId,
  now = Date.now,
  onChange = async () => {},
  onDiscard = () => {},
}) {
  let grant = null;
  let grantLoaded = false;
  let storeUnreadable = false;
  let reauthorizationFlagged = false;
  let refreshFlight = null;

  async function loadGrant() {
    if (grantLoaded) return grant;
    const epochBeforeLoad = tokenStore.epoch;
    try {
      const loaded = await tokenStore.load();
      if (epochBeforeLoad === tokenStore.epoch) {
        grant = loaded;
        grantLoaded = true;
      }
      storeUnreadable = false;
      return epochBeforeLoad === tokenStore.epoch ? grant : null;
    } catch {
      // Corrupt file or wrong key: fail closed.
      storeUnreadable = true;
      return null;
    }
  }

  function isRefreshTokenUsable(candidate) {
    return candidate !== null && candidate.refreshTokenExpiresAt > now();
  }

  /** Tell the owner of this manager which state we are in now; it clears cached data. */
  async function announceChange(state) {
    try {
      await onChange({ state });
    } catch {
      // A failing listener must not undo or block credential changes.
    }
  }

  /** Drop local credentials everywhere. `flagged` marks revoked access instead of a user choice. */
  async function discardCredentials({ flagged }) {
    refreshFlight = null;
    onDiscard();
    grant = null;
    grantLoaded = true;
    storeUnreadable = false;
    reauthorizationFlagged = flagged;
    let removalError = null;
    try {
      await tokenStore.remove();
    } catch (error) {
      removalError = error;
    }
    await announceChange(flagged ? 'reconnect_required' : 'not_connected');
    if (removalError) throw new ShopifyError('disconnect_failed');
  }

  function disconnect() {
    return discardCredentials({ flagged: false });
  }

  /**
   * Called by the API runner after a repeated 401 or scope-denied 403. `accessToken` is the token
   * the failed request used: if a refresh or reconnect has since replaced it, the newer grant is
   * left alone. Without it the current grant is revoked unconditionally.
   */
  async function markReauthorizationRequired({ accessToken } = {}) {
    if (accessToken !== undefined && refreshFlight) {
      // A refresh may be about to replace the token that failed; let it settle first.
      await refreshFlight.catch(() => {});
    }
    const existing = await loadGrant();
    // After a local disconnect there is nothing left to flag, and nothing may be restored.
    if (existing === null && !storeUnreadable) return;
    if (accessToken !== undefined && existing !== null && existing.accessToken !== accessToken) {
      return;
    }
    try {
      await discardCredentials({ flagged: true });
    } catch {
      // Memory is already cleared and flagged; the on-disk removal failure surfaces on next load.
    }
  }

  /** One refresh at a time; persist the rotated refresh token BEFORE anyone can use the result. */
  function refreshGrant(startingGrant) {
    if (refreshFlight) return refreshFlight;
    const startingEpoch = tokenStore.epoch;
    const flight = (async () => {
      if (!isRefreshTokenUsable(startingGrant)) {
        await markReauthorizationRequired();
        throw new ShopifyError('reauthorization_required');
      }
      let session;
      let upstreamStatus = null;
      try {
        session = await runWithBoundedFetch(boundedFetch, async (context) => {
          try {
            const result = await shopify.auth.refreshToken({
              shop: store,
              refreshToken: startingGrant.refreshToken,
            });
            return result.session;
          } finally {
            upstreamStatus = context.lastStatus;
          }
        });
      } catch {
        if (PERMANENT_REFRESH_STATUSES.has(upstreamStatus) && startingEpoch === tokenStore.epoch) {
          await markReauthorizationRequired();
          throw new ShopifyError('reauthorization_required');
        }
        throw new ShopifyError('refresh_unavailable');
      }
      if (startingEpoch !== tokenStore.epoch) throw new ShopifyError('reauthorization_required');
      let refreshed;
      try {
        refreshed = grantFromSession(session, { store, clientId, now });
      } catch {
        throw new ShopifyError('refresh_unavailable');
      }
      try {
        const savedEpoch = await tokenStore.save(refreshed, startingEpoch);
        if (savedEpoch !== tokenStore.epoch) throw new ShopifyError('stale_write');
      } catch (error) {
        if (error instanceof ShopifyError && error.code === 'stale_write') {
          throw new ShopifyError('reauthorization_required');
        }
        throw new ShopifyError('refresh_unavailable');
      }
      grant = refreshed;
      return refreshed;
    })();
    refreshFlight = flight;
    const clear = () => {
      if (refreshFlight === flight) refreshFlight = null;
    };
    flight.then(clear, clear);
    return flight;
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    const current = await loadGrant();
    if (current === null) throw new ShopifyError('reauthorization_required');
    const expiresSoon = current.accessTokenExpiresAt - now() <= REFRESH_EARLY_MS;
    if (!forceRefresh && !expiresSoon) return current.accessToken;
    try {
      const refreshed = await refreshGrant(current);
      return refreshed.accessToken;
    } catch (error) {
      const stillValid = current.accessTokenExpiresAt > now();
      const isTransient = error instanceof ShopifyError && error.code === 'refresh_unavailable';
      // A transient outage must not break reads while the current token is still genuinely valid.
      if (!forceRefresh && isTransient && stillValid && grant === current) {
        return current.accessToken;
      }
      throw error;
    }
  }

  /** 'not_connected' | 'connected' | 'reconnect_required' */
  async function currentState() {
    const current = await loadGrant();
    if (storeUnreadable || reauthorizationFlagged) return 'reconnect_required';
    if (current === null) return 'not_connected';
    return isRefreshTokenUsable(current) ? 'connected' : 'reconnect_required';
  }

  /**
   * Persist a freshly authorized SDK session as the new grant lineage. `startingEpoch` is the
   * store epoch captured BEFORE the slow code exchange; a disconnect meanwhile makes this refuse.
   * Returns true when the grant is saved and active.
   */
  async function installSession(session, startingEpoch) {
    let newGrant;
    try {
      newGrant = grantFromSession(session, { store, clientId, now });
    } catch {
      return false;
    }
    try {
      const savedEpoch = await tokenStore.replace(newGrant, startingEpoch);
      if (savedEpoch !== tokenStore.epoch) return false;
    } catch {
      return false;
    }
    grant = newGrant;
    grantLoaded = true;
    storeUnreadable = false;
    reauthorizationFlagged = false;
    refreshFlight = null;
    await announceChange('connected');
    return true;
  }

  return {
    get epoch() {
      return tokenStore.epoch;
    },
    currentState,
    getAccessToken,
    markReauthorizationRequired,
    disconnect,
    installSession,
  };
}
