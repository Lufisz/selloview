// The owner's own endpoints: who is signed in (and their store connection), their workspace
// settings, and whether sign-up is open. The workspace is always the session user's; no owner or
// workspace id is read from the request.
import { assertSameOriginJson, readJsonObject } from '../http/guards.mjs';
import { ensureWorkspace, updateWorkspaceSettings } from './workspaces.mjs';

const SESSION_PATH = '/api/session';
const SETTINGS_PATH = '/api/settings';
const REGISTRATION_PATH = '/api/registration';

/**
 * @param {object} dependencies
 * @param {import('node:sqlite').DatabaseSync} dependencies.database
 * @param {string} dependencies.origin
 * @param {ReturnType<typeof import('./registration.mjs').createRegistrationPolicy>} dependencies.registration
 * @param {{inspect: (workspaceId: string, ownerEmail: string) => Promise<{connection: object}>}} dependencies.shopify
 * @param {(response, status, body, extraHeaders?) => void} dependencies.reply
 * @param {(request) => Promise<object|null>} dependencies.lookupSession
 * @param {(request, response) => Promise<object|null>} dependencies.requireCsrfSession
 * @param {(sessionId: string) => string} dependencies.csrfTokenFor
 * @returns {Map<string, Function>} handlers keyed by `METHOD /path`
 */
export function createOwnerRoutes({
  database,
  origin,
  registration,
  shopify,
  reply,
  lookupSession,
  requireCsrfSession,
  csrfTokenFor,
}) {
  async function describeOwner(sessionData) {
    const workspace = ensureWorkspace(database, sessionData.user.id);
    const { connection } = await shopify.inspect(workspace.id, sessionData.user.email);
    return {
      owner: { email: sessionData.user.email },
      sessionExpiresAt: new Date(sessionData.session.expiresAt).toISOString(),
      workspace: {
        name: workspace.name,
        revision: workspace.revision,
        settings: workspace.settings,
      },
      storeConnection: connection,
      csrfToken: csrfTokenFor(sessionData.session.id),
    };
  }

  // Safe to show anyone: whether sign-up exists and has room, never counts or emails.
  function serveRegistrationStatus(request, response) {
    return reply(response, 200, registration.status(), { 'Cache-Control': 'no-store' });
  }

  async function serveSession(request, response) {
    const sessionData = await lookupSession(request);
    if (!sessionData) return reply(response, 401, { error: 'unauthenticated' });
    return reply(response, 200, await describeOwner(sessionData));
  }

  async function saveSettings(request, response) {
    assertSameOriginJson(request, origin);
    const sessionData = await requireCsrfSession(request, response);
    if (!sessionData) return;
    const body = await readJsonObject(request, ['settings', 'revision']);
    const result = updateWorkspaceSettings(database, sessionData.user.id, {
      patch: body.settings,
      expectedRevision: body.revision,
    });
    if (result.status === 'invalid') return reply(response, 400, { error: 'invalid_request' });
    const status = result.status === 'ok' ? 200 : 409;
    return reply(response, status, {
      status: result.status,
      revision: result.workspace.revision,
      settings: result.workspace.settings,
    });
  }

  return new Map([
    [`GET ${REGISTRATION_PATH}`, serveRegistrationStatus],
    [`GET ${SESSION_PATH}`, serveSession],
    [`POST ${SETTINGS_PATH}`, saveSettings],
  ]);
}
