// Shared setup for the server tests. Everything here is synthetic: temporary databases under the
// OS temp directory (TMPDIR), disposable emails on example.test, and an in-memory mail transport
// that stands in for the provider. The authentication, session and rate-limit code under test is
// the real Better Auth library running against real SQLite files.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../../server/accounts/auth.mjs';
import {
  initializeDatabase,
  inviteOwner,
  openInitializedDatabase,
} from '../../server/accounts/accounts.mjs';
import { createAppServer } from '../../server/app.mjs';
import { createShopifyService } from '../../server/shopify/connection-service.mjs';

/** SYNTHETIC delivery: records codes in memory so tests can complete the real sign-in flow. */
export function createMemoryMailTransport() {
  const messages = [];
  return {
    configured: true,
    messages,
    async sendSignInCode({ recipient, code }) {
      messages.push({ recipient, code });
    },
    lastCodeFor(recipient) {
      return messages.findLast((message) => message.recipient === recipient)?.code;
    },
  };
}

export function createFailingMailTransport() {
  return {
    configured: true,
    async sendSignInCode() {
      throw new Error('synthetic provider outage');
    },
  };
}

export async function findFreePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function makeTemporaryDirectory(t) {
  const base = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'selloview-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Creates an initialized private database and returns the settings to open it again. */
export async function createAppEnvironment(t, { invites = [] } = {}) {
  const directory = await makeTemporaryDirectory(t);
  const databasePath = path.join(directory, 'private', 'selloview.sqlite');
  const secret = crypto.randomBytes(48).toString('base64url');
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  await initializeDatabase({ databasePath, secret, origin });

  const database = openInitializedDatabase(databasePath);
  for (const email of invites) await inviteOwner({ database, secret, origin, email });
  database.close();
  return { directory, databasePath, secret, origin, port };
}

/** Starts the real app HTTP server on loopback. Returns a handle with close(). */
export async function startAppServer(
  t,
  environment,
  {
    mailTransport,
    trustedIpHeader = '',
    shopifyConfig = { status: 'setup_required' },
    fetchImpl,
    now,
    refreshIntervalMs,
  } = {},
) {
  const transport = mailTransport ?? createMemoryMailTransport();
  const database = openInitializedDatabase(environment.databasePath);
  const auth = createAuth({
    database,
    secret: environment.secret,
    origin: environment.origin,
    mailTransport: transport,
  });
  const config = { origin: environment.origin, secret: environment.secret, trustedIpHeader };
  // The Shopify side is real service code; only its outbound transport is a synthetic fixture.
  const shopify = createShopifyService({
    database,
    config: shopifyConfig,
    origin: environment.origin,
    fetchImpl,
    now,
    refreshIntervalMs,
  });
  const server = createAppServer({
    auth,
    database,
    config,
    mailTransport: transport,
    shopify,
  });
  await new Promise((resolve) => server.listen(environment.port, '127.0.0.1', resolve));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
  t.after(close);
  return {
    server,
    database,
    auth,
    shopify,
    mailTransport: transport,
    origin: environment.origin,
    close,
  };
}

// This sandbox blocks Node's own client sockets to loopback (the existing suites skip for the
// same reason), but other processes can reach the listener. Real HTTP therefore goes through the
// curl binary; when curl is missing the callers skip with a label instead of faking a result.
const CURL_TIMEOUT_SECONDS = 10;
export const BROWSER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export async function curlAvailable() {
  return new Promise((resolve) => {
    const child = spawn('curl', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

class ResponseHeaders {
  constructor(lines) {
    this.lines = lines;
  }
  get(name) {
    const wanted = name.toLowerCase();
    const line = this.lines.find((entry) => entry.name === wanted);
    return line ? line.value : null;
  }
  getSetCookie() {
    return this.lines.filter((entry) => entry.name === 'set-cookie').map((entry) => entry.value);
  }
}

function parseCurlOutput(output) {
  const separator = output.indexOf('\r\n\r\n');
  const head = output.slice(0, separator).split('\r\n');
  const text = output.slice(separator + 4);
  const status = Number(head[0].split(' ')[1]);
  const lines = head.slice(1).map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() };
  });
  return { status, headers: new ResponseHeaders(lines), text };
}

/** One real HTTP/1.1 request to a loopback listener. `headerLines` may repeat a header name. */
export function httpRequest({ origin, pathname, method = 'GET', headerLines = [], body }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',
      '-i',
      '--http1.1',
      '--path-as-is',
      '-m',
      String(CURL_TIMEOUT_SECONDS),
      '-X',
      method,
    ];
    for (const line of headerLines) args.push('-H', line);
    if (body !== undefined) args.push('--data-binary', '@-');
    args.push(origin + pathname);
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`curl exited with ${code}`));
      const parsed = parseCurlOutput(Buffer.concat(chunks).toString('utf8'));
      let json = null;
      try {
        json = JSON.parse(parsed.text);
      } catch {
        json = null;
      }
      resolve({ ...parsed, json });
    });
    child.stdin.end(body ?? '');
  });
}

/** Minimal cookie-keeping HTTP client that behaves like one browser profile. */
export function createBrowser(origin) {
  const cookies = new Map();
  // Attributes a real browser consults before sending a cookie back.
  const attributes = new Map();
  let csrfToken = '';

  function readAttribute(setCookie, name) {
    const match = new RegExp(`;\\s*${name}=([^;]*)`, 'i').exec(setCookie);
    return match ? match[1].trim() : '';
  }

  // Path matching and SameSite=Strict, as browsers apply them. `crossSite` is a navigation that
  // started on another site (the redirect back from Shopify), which never carries Strict cookies.
  function cookieHeader({ pathname = '/', crossSite = false } = {}) {
    const sent = [];
    for (const [name, value] of cookies) {
      const { path, sameSite } = attributes.get(name) ?? { path: '/', sameSite: '' };
      const pathMatches =
        pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
      const blocked = crossSite && sameSite.toLowerCase() === 'strict';
      if (pathMatches && !blocked) sent.push(`${name}=${value}`);
    }
    return sent.join('; ');
  }

  function storeCookies(response) {
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const isCleared = /max-age=0/i.test(setCookie) || value === '';
      if (isCleared) {
        cookies.delete(name);
        attributes.delete(name);
      } else {
        cookies.set(name, value);
        attributes.set(name, {
          path: readAttribute(setCookie, 'path') || '/',
          sameSite: readAttribute(setCookie, 'samesite'),
        });
      }
    }
  }

  async function request(
    pathname,
    { method = 'GET', body, headers = {}, rawBody, crossSite = false } = {},
  ) {
    const requestHeaders = { ...headers };
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      requestHeaders['Content-Type'] ??= 'application/json';
    }
    if (method === 'POST') requestHeaders.Origin ??= origin;
    const headerLines = Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`);
    const cookie = cookieHeader({ pathname: pathname.split('?')[0], crossSite });
    if (cookie) headerLines.push(`Cookie: ${cookie}`);
    const result = await httpRequest({ origin, pathname, method, headerLines, body: payload });
    storeCookies(result);
    return result;
  }

  return {
    cookies,
    attributes,
    request,
    cookieHeader,
    get csrfToken() {
      return csrfToken;
    },
    set csrfToken(value) {
      csrfToken = value;
    },
    requestCode(email) {
      return request('/api/auth/email-otp/send-verification-otp', {
        method: 'POST',
        body: { email, type: 'sign-in' },
      });
    },
    verifyCode(email, otp) {
      return request('/api/auth/sign-in/email-otp', { method: 'POST', body: { email, otp } });
    },
    async loadSession() {
      const result = await request('/api/session');
      csrfToken = result.json?.csrfToken ?? '';
      return result;
    },
    saveSettings(settings, revision, extra = {}) {
      return request('/api/settings', {
        method: 'POST',
        body: { settings, revision },
        headers: { 'X-CSRF-Token': csrfToken, ...extra },
      });
    },
    signOut() {
      return request('/api/auth/sign-out', {
        method: 'POST',
        body: {},
        headers: { 'X-CSRF-Token': csrfToken },
      });
    },
    // TV side (anonymous; identified only by the cookies this browser keeps).
    createTvChallenge(headers = {}) {
      return request('/api/tv/challenge', { method: 'POST', body: {}, headers });
    },
    pairingStatus(headers = {}) {
      return request('/api/tv/pairing', { headers });
    },
    exchangePairing(headers = {}) {
      return request('/api/tv/pairing/exchange', { method: 'POST', body: {}, headers });
    },
    loadDisplay(headers = {}) {
      return request('/api/display', { headers });
    },
    loadLogo(query = '') {
      return request(`/api/display/logo${query}`);
    },
    // Shopify connection (owner side).
    shopifyStatus() {
      return request('/api/shopify');
    },
    startShopify(store, extra = {}) {
      return request('/api/shopify/start', {
        method: 'POST',
        body: { store },
        headers: { 'X-CSRF-Token': csrfToken, 'User-Agent': BROWSER_AGENT, ...extra },
      });
    },
    disconnectShopify(extra = {}) {
      return request('/api/shopify/disconnect', {
        method: 'POST',
        body: {},
        headers: { 'X-CSRF-Token': csrfToken, ...extra },
      });
    },
    /** The redirect back from Shopify: a cross-site GET, so no SameSite=Strict cookies. */
    shopifyCallback(query, extra = {}) {
      return request(`/auth/beta/shopify/callback?${query}`, {
        crossSite: true,
        headers: { 'User-Agent': BROWSER_AGENT, ...extra },
      });
    },
    // Owner side.
    listScreens() {
      return request('/api/screens');
    },
    pairScreen(code, name, extra = {}) {
      return request('/api/screens/pair', {
        method: 'POST',
        body: { code, name },
        headers: { 'X-CSRF-Token': csrfToken, ...extra },
      });
    },
    revokeScreen(id, extra = {}) {
      return request('/api/screens/revoke', {
        method: 'POST',
        body: { id },
        headers: { 'X-CSRF-Token': csrfToken, ...extra },
      });
    },
  };
}

/** Full real sign-in for an invited email using the in-memory transport. */
export async function signInOwner(handle, email) {
  const browser = createBrowser(handle.origin);
  const sent = await browser.requestCode(email);
  if (sent.status !== 200) throw new Error(`code request failed with ${sent.status}`);
  const code = handle.mailTransport.lastCodeFor(email);
  const verified = await browser.verifyCode(email, code);
  if (verified.status !== 200) throw new Error(`sign-in failed with ${verified.status}`);
  const session = await browser.loadSession();
  return { browser, session: session.json, code };
}
