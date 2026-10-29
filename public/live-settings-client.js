// Optional shared dashboard settings (reporting period and theme) for the live board.
// Only talks to the same-origin /api/settings endpoint. The server decides whether the
// feature exists: a 404 means "disabled" and the board keeps its local-only preferences.
// The CSRF token returned by the server stays in this module's memory, never in storage.

export const SETTINGS_PATH = '/api/settings';
export const SETTINGS_PERIODS = Object.freeze(['today', 'week', 'month', 'days60']);
export const SETTINGS_THEMES = Object.freeze(['light', 'dark']);
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_REVISION = 1_000_000_000;

export const SETTINGS_MESSAGES = Object.freeze({
  saveFailed:
    'Could not save the shared setting. This screen may return to the saved choice at the next refresh.',
  conflict: 'Another screen changed the settings first. Showing the newer saved choices.',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
}

/** Returns {period, theme} only when both fields are known values. */
export function parseSettings(value) {
  if (!isPlainObject(value)) return null;
  if (!SETTINGS_PERIODS.includes(value.period) || !SETTINGS_THEMES.includes(value.theme)) {
    return null;
  }
  return { period: value.period, theme: value.theme };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<
 *   {status:'ok', revision:number, settings:{period:string, theme:string}, csrfToken:string}
 *   | {status:'disabled'|'unauthorized'|'offline'|'error'}>}
 */
export async function fetchSettings({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(SETTINGS_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'offline' };
  }
  if (response.status === 404) return { status: 'disabled' };
  if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
  if (!response.ok) return { status: 'error' };
  const body = await readJson(response);
  const settings = parseSettings(body?.settings);
  const isValid =
    body?.enabled === true &&
    settings &&
    isRevision(body.revision) &&
    typeof body.csrfToken === 'string' &&
    CSRF_TOKEN_PATTERN.test(body.csrfToken);
  if (!isValid) return { status: 'error' };
  return { status: 'ok', revision: body.revision, settings, csrfToken: body.csrfToken };
}

/**
 * Sends a partial settings change guarded by the revision the caller last saw.
 * @returns {Promise<
 *   {status:'ok'|'conflict', revision:number, settings:{period:string, theme:string}}
 *   | {status:'disabled'|'security'|'offline'|'error'}>}
 */
export async function saveSettings({
  revision,
  patch,
  csrfToken,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(SETTINGS_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ revision, settings: patch }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'offline' };
  }
  if (response.status === 404) return { status: 'disabled' };
  if (response.status === 403) return { status: 'security' };
  const body = await readJson(response);
  const settings = parseSettings(body?.settings);
  const carriesState = settings && isRevision(body?.revision);
  if (response.ok && carriesState) return { status: 'ok', revision: body.revision, settings };
  if (response.status === 409 && body?.error === 'revision_conflict' && carriesState) {
    return { status: 'conflict', revision: body.revision, settings };
  }
  return { status: 'error' };
}

/**
 * Coordinates polling and saving so that:
 *  - saves run one at a time, each against the newest known revision;
 *  - a read that started before a local change (or while a save is pending) is discarded,
 *    so an older server answer can never undo a newer local choice;
 *  - a never-saved server (revision 0) does not overwrite this browser's own preferences;
 *    the first save sends this browser's complete settings instead.
 *
 * Callbacks: getLocalSettings() -> {period, theme}; applySettings(settings) when the server's
 * choices should replace local ones; notify('saveFailed'|'conflict') to tell the user.
 */
export function createSettingsSync({
  getLocalSettings,
  applySettings,
  notify,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let enabled = null;
  let revision = 0;
  let csrfToken = '';
  let pendingPatch = {};
  let localChangeCount = 0;
  let flushing = null;

  function hasPendingWork() {
    return Object.keys(pendingPatch).length > 0 || flushing !== null;
  }

  async function load() {
    if (enabled === false) return;
    const changeCountAtStart = localChangeCount;
    const outcome = await fetchSettings({ fetchImpl, timeoutMs });
    if (outcome.status === 'disabled') {
      enabled = false;
      csrfToken = '';
      pendingPatch = {};
      return;
    }
    if (outcome.status !== 'ok') return;
    // Bootstrap needs the server revision/token even if the user changed a control while
    // waiting. Save that queued choice rather than dropping it or applying older settings.
    if (enabled === null) {
      enabled = true;
      revision = outcome.revision;
      csrfToken = outcome.csrfToken;
      if (Object.keys(pendingPatch).length > 0) {
        if (revision === 0) pendingPatch = { ...getLocalSettings(), ...pendingPatch };
        await scheduleFlush();
        return;
      }
    }
    // Stale: the user changed something after this request began, or a save is under way.
    if (changeCountAtStart !== localChangeCount || hasPendingWork()) return;
    enabled = true;
    revision = outcome.revision;
    csrfToken = outcome.csrfToken;
    if (revision > 0) applySettings(outcome.settings);
  }

  async function sendNextPatch() {
    const patch = pendingPatch;
    pendingPatch = {};
    const outcome = await saveSettings({ revision, patch, csrfToken, fetchImpl, timeoutMs });
    if (outcome.status === 'ok') {
      revision = outcome.revision;
      return;
    }
    // Later local choices were made on top of this failed one; they are dropped with it
    // rather than sent against a state the user has not seen.
    pendingPatch = {};
    if (outcome.status === 'conflict') {
      revision = outcome.revision;
      applySettings(outcome.settings);
      notify('conflict');
      return;
    }
    if (outcome.status === 'disabled') enabled = false;
    // The CSRF token may predate a server restart: fetch a fresh one on the next poll.
    if (outcome.status === 'security') csrfToken = '';
    notify('saveFailed');
  }

  async function flush() {
    while (Object.keys(pendingPatch).length > 0) {
      await sendNextPatch();
    }
  }

  function scheduleFlush() {
    if (!flushing) {
      flushing = flush().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  /** Records a local choice. A no-op when the server does not offer shared settings. */
  function change(patch) {
    // Counted even when nothing is sent, so an in-flight read cannot overwrite this choice.
    localChangeCount += 1;
    if (enabled === null) {
      pendingPatch = { ...pendingPatch, ...patch };
      return Promise.resolve();
    }
    if (enabled !== true || csrfToken === '') {
      // Disabled or not loaded yet: the choice stays local. A lost token is a real failure.
      if (enabled === true) notify('saveFailed');
      return Promise.resolve();
    }
    const baseline = revision === 0 ? getLocalSettings() : {};
    pendingPatch = { ...baseline, ...pendingPatch, ...patch };
    return scheduleFlush();
  }

  return { load, change, isEnabled: () => enabled === true };
}
