// TV pairing and display sessions over real HTTP (curl) against real SQLite files. Owners sign in
// through the real Better Auth flow with the synthetic in-memory mail transport; the TV clients
// are separate cookie jars. Direct database writes are used only to age rows (expiry) or to set
// up a clearly labelled fixture (capacity limits).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHandler } from '../../server/demo.mjs';
import {
  AccountError,
  migrateDatabase,
  openInitializedDatabase,
} from '../../server/accounts/accounts.mjs';
import { createRateLimiter } from '../../server/http/rate-limiter.mjs';
import {
  MAX_OPEN_CHALLENGES,
  MAX_SCREENS_PER_WORKSPACE,
  approveChallenge,
  formatCode,
  normalizeCode,
  parseScreenName,
} from '../../server/screens/screens.mjs';
import {
  createBetaEnvironment,
  createBrowser,
  curlAvailable,
  httpRequest,
  signInOwner,
  startBetaServer,
} from '../helpers/app-server.mjs';

const http = { skip: (await curlAvailable()) ? false : 'curl is not installed' };

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const FIVE_MINUTES_SECONDS = 5 * 60;
const TRUSTED_IP_HEADER = 'x-test-client-ip';
const LONG_AGO = 946684800000;

async function setup(t, options = {}) {
  const environment = await createBetaEnvironment(t, { invites: [ALICE, BOB] });
  const handle = await startBetaServer(t, environment, options);
  const alice = await signInOwner(handle, ALICE);
  const bob = await signInOwner(handle, BOB);
  return { environment, handle, alice: alice.browser, bob: bob.browser };
}

/** A TV page that asked for a code. Returns its browser and the visible code. */
async function newTv(handle, headers = {}) {
  const tv = createBrowser(handle.origin);
  const created = await tv.createTvChallenge(headers);
  assert.equal(created.status, 201);
  return { tv, code: created.json.code };
}

/** Full happy path for one TV and one owner; returns the paired TV browser. */
async function pairTv(handle, owner, name, headers = {}) {
  const { tv, code } = await newTv(handle, headers);
  const approved = await owner.pairScreen(code, name);
  assert.equal(approved.status, 200);
  const exchanged = await tv.exchangePairing(headers);
  assert.equal(exchanged.status, 200);
  return tv;
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}

function cookieNamed(response, name) {
  return response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
}

function cookieSecret(browser, name) {
  return browser.cookies.get(name);
}

function forgeStatus(response) {
  return { status: response.status, body: response.text };
}

// ---- Happy path and what the display may see ------------------------------------------------

test('a TV pairs through an owner approval and then sees only its appearance', http, async (t) => {
  const { handle, alice } = await setup(t);
  const tv = createBrowser(handle.origin);

  assert.equal((await tv.loadDisplay()).status, 401);
  assert.equal((await tv.pairingStatus()).status, 404);

  const created = await tv.createTvChallenge();
  assert.equal(created.status, 201);
  assert.match(created.json.code, CODE_SHAPE);
  assert.deepEqual(Object.keys(created.json).sort(), ['code', 'expiresAt']);
  const challengeCookie = cookieNamed(created, 'metrictv_tv_challenge');
  assert.match(challengeCookie, /HttpOnly/i);
  assert.match(challengeCookie, /SameSite=Strict/i);
  assert.match(challengeCookie, /Path=\//);
  assert.match(challengeCookie, new RegExp(`Max-Age=${FIVE_MINUTES_SECONDS}\\b`));
  assert.equal(/;\s*Secure/i.test(challengeCookie), false, 'loopback http only for local tests');
  assert.equal(/Domain=/i.test(challengeCookie), false);
  const secret = cookieSecret(tv, 'metrictv_tv_challenge');
  assert.equal(created.text.includes(secret), false, 'the secret is only in the cookie');

  const pending = await tv.pairingStatus();
  assert.equal(pending.status, 200);
  assert.equal(pending.json.state, 'pending');
  assert.equal(pending.text.includes(created.json.code), false);
  assert.equal((await tv.exchangePairing()).status, 409, 'not approved yet');
  assert.equal((await tv.loadDisplay()).status, 401);

  const approved = await alice.pairScreen(created.json.code.toLowerCase(), '  Office TV ');
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.json, { status: 'approved', name: 'Office TV' });
  assert.equal((await tv.loadDisplay()).status, 401, 'approved but not exchanged is no session');
  assert.equal((await alice.listScreens()).json.screens.length, 0);
  assert.equal((await tv.pairingStatus()).json.state, 'approved');

  const exchanged = await tv.exchangePairing();
  assert.equal(exchanged.status, 200);
  assert.deepEqual(exchanged.json, { ok: true });
  const displayCookie = cookieNamed(exchanged, 'metrictv_tv_display');
  assert.match(displayCookie, /HttpOnly/i);
  assert.match(displayCookie, /SameSite=Strict/i);
  assert.match(displayCookie, new RegExp(`Max-Age=${THIRTY_DAYS_SECONDS}\\b`));
  assert.match(cookieNamed(exchanged, 'metrictv_tv_challenge'), /Max-Age=0/);
  assert.equal(tv.cookies.has('metrictv_tv_challenge'), false);

  const aliceSession = await alice.loadSession();
  const display = await tv.loadDisplay();
  assert.equal(display.status, 200);
  assert.deepEqual(Object.keys(display.json).sort(), [
    'appVersion',
    'revision',
    'screen',
    'serverTime',
    'settings',
    'storeConnection',
  ]);
  assert.deepEqual(display.json.screen, { name: 'Office TV' });
  assert.deepEqual(display.json.settings, { period: 'week', theme: 'light' });
  assert.deepEqual(display.json.storeConnection, { state: 'setup_required' });
  const workspaceId = handle.database.prepare('SELECT id FROM workspace LIMIT 1').get().id;
  for (const forbidden of [ALICE, aliceSession.json.csrfToken, 'csrf', 'token', 'shopify']) {
    assert.equal(display.text.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(display.text.includes(workspaceId), false);
  assert.equal(display.headers.get('cache-control'), 'no-store');

  // Appearance changes reach the TV; owner saves with the real settings endpoint.
  const saved = await alice.saveSettings({ theme: 'dark', period: 'month' }, 0);
  assert.equal(saved.status, 200);
  const updated = await tv.loadDisplay();
  assert.deepEqual(updated.json.settings, { period: 'month', theme: 'dark' });
  assert.equal(updated.json.revision, 1);

  const listed = await alice.listScreens();
  assert.equal(listed.status, 200);
  assert.equal(listed.json.screens.length, 1);
  const [screen] = listed.json.screens;
  assert.deepEqual(Object.keys(screen).sort(), [
    'expiresAt',
    'id',
    'lastSeenAt',
    'name',
    'pairedAt',
  ]);
  assert.equal(screen.name, 'Office TV');
  assert.ok(screen.lastSeenAt, 'last seen is recorded when the TV loads its display');
  const lifetimeMs = Date.parse(screen.expiresAt) - Date.parse(screen.pairedAt);
  assert.equal(lifetimeMs, THIRTY_DAYS_SECONDS * 1000, 'a fixed 30-day lifetime, never extended');
  assert.equal(listed.text.includes(cookieSecret(tv, 'metrictv_tv_display')), false);
});

test('only hashes of the secrets and codes are stored', http, async (t) => {
  const { handle, alice } = await setup(t);
  const { tv, code } = await newTv(handle);
  const challengeSecret = cookieSecret(tv, 'metrictv_tv_challenge');
  await alice.pairScreen(code, 'Hall');
  await tv.exchangePairing();
  const displaySecret = cookieSecret(tv, 'metrictv_tv_display');

  const rows = JSON.stringify([
    handle.database.prepare('SELECT * FROM pairing_challenge').all(),
    handle.database.prepare('SELECT * FROM display_session').all(),
  ]);
  assert.equal(rows.includes(displaySecret.split('.')[1]), false);
  assert.equal(rows.includes(challengeSecret.split('.')[1]), false);
  assert.equal(rows.includes(code.replace('-', '')), false);
  const stored = handle.database.prepare('SELECT secret_hash FROM display_session').get();
  assert.match(stored.secret_hash, /^[0-9a-f]{64}$/);
});

// ---- Challenge binding, replay, expiry ------------------------------------------------------

test('the visible code alone cannot claim an approved screen', http, async (t) => {
  const { handle, alice } = await setup(t);
  const { tv, code } = await newTv(handle);
  await alice.pairScreen(code, 'Lobby');

  const thief = createBrowser(handle.origin);
  assert.equal((await thief.pairingStatus()).status, 404);
  assert.equal((await thief.exchangePairing()).status, 404);
  assert.equal(thief.cookies.size, 0);

  // Another TV with its own challenge cannot exchange the approved one either.
  const other = await newTv(handle);
  assert.equal((await other.tv.exchangePairing()).status, 409);

  // A forged cookie with the real challenge id but a guessed secret fails.
  const [challengeId] = cookieSecret(tv, 'metrictv_tv_challenge').split('.');
  const forged = `metrictv_tv_challenge=${challengeId}.${'A'.repeat(43)}`;
  const forgedStatus = await httpRequest({
    origin: handle.origin,
    pathname: '/api/tv/pairing',
    headerLines: [`Cookie: ${forged}`],
  });
  assert.equal(forgedStatus.status, 404);
  assert.equal(count(handle.database, 'display_session'), 0);

  // The real holder still succeeds afterwards.
  assert.equal((await tv.exchangePairing()).status, 200);
});

test('codes and challenges are one-use; replays are refused', http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const { tv, code } = await newTv(handle);
  const savedCookie = tv.cookieHeader();

  assert.equal((await alice.pairScreen(code, 'First')).status, 200);
  const replayedCode = await bob.pairScreen(code, 'Second');
  assert.equal(replayedCode.status, 400);
  assert.equal(replayedCode.json.error, 'invalid_code');
  assert.equal((await alice.pairScreen(code, 'Again')).status, 400);

  assert.equal((await tv.exchangePairing()).status, 200);
  const replayedExchange = await httpRequest({
    origin: handle.origin,
    pathname: '/api/tv/pairing/exchange',
    method: 'POST',
    headerLines: [
      `Origin: ${handle.origin}`,
      'Content-Type: application/json',
      `Cookie: ${savedCookie}`,
    ],
    body: '{}',
  });
  assert.equal(replayedExchange.status, 404);
  assert.equal(count(handle.database, 'display_session'), 1);
  assert.equal(count(handle.database, 'pairing_challenge'), 0);
  assert.equal((await alice.pairScreen(code, 'After')).status, 400);
});

test('expired challenges cannot be polled, approved or exchanged', http, async (t) => {
  const { handle, alice } = await setup(t);

  const pending = await newTv(handle);
  handle.database.prepare('UPDATE pairing_challenge SET expires_at = ?').run(LONG_AGO);
  assert.equal((await pending.tv.pairingStatus()).status, 404);
  const lateApproval = await alice.pairScreen(pending.code, 'Late');
  assert.equal(lateApproval.status, 400);
  assert.equal(lateApproval.json.error, 'invalid_code');

  const approved = await newTv(handle);
  assert.equal((await alice.pairScreen(approved.code, 'Slow')).status, 200);
  handle.database
    .prepare("UPDATE pairing_challenge SET expires_at = ? WHERE state = 'approved'")
    .run(LONG_AGO);
  assert.equal((await approved.tv.exchangePairing()).status, 404);
  assert.equal(count(handle.database, 'display_session'), 0);
});

test(
  "a new challenge replaces the same TV page's earlier one and expired rows are purged",
  http,
  async (t) => {
    const { handle } = await setup(t);
    const { tv } = await newTv(handle);
    await tv.createTvChallenge();
    assert.equal(count(handle.database, 'pairing_challenge'), 1);

    handle.database.prepare('UPDATE pairing_challenge SET expires_at = ?').run(LONG_AGO);
    await newTv(handle);
    assert.equal(count(handle.database, 'pairing_challenge'), 1, 'expired rows do not accumulate');
  },
);

test('wrong, expired and used codes answer identically and reveal no owner', http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const used = await newTv(handle);
  await alice.pairScreen(used.code, 'Mine');
  const expired = await newTv(handle);
  handle.database
    .prepare("UPDATE pairing_challenge SET expires_at = ? WHERE state = 'pending'")
    .run(LONG_AGO);

  const wrong = forgeStatus(await bob.pairScreen('ZZZZ-ZZZZ', 'Bob screen'));
  const usedByAlice = forgeStatus(await bob.pairScreen(used.code, 'Bob screen'));
  const expiredCode = forgeStatus(await bob.pairScreen(expired.code, 'Bob screen'));
  const malformed = forgeStatus(await bob.pairScreen('not a code', 'Bob screen'));
  assert.equal(wrong.status, 400);
  assert.deepEqual(usedByAlice, wrong);
  assert.deepEqual(expiredCode, wrong);
  assert.deepEqual(malformed, wrong);
  assert.equal(wrong.body.includes('alice'), false);
});

// ---- Rate limits and bounded storage --------------------------------------------------------

test('code guessing is limited per owner without locking out other owners', http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const valid = await newTv(handle);

  for (let guess = 0; guess < 5; guess += 1) {
    const result = await alice.pairScreen('ABCD-EFG' + 'HJKMN'[guess], 'Guess');
    assert.equal(result.status, 400);
  }
  const locked = await alice.pairScreen(valid.code, 'Locked out');
  assert.equal(locked.status, 429, 'even the right code is refused while locked out');
  assert.match(locked.headers.get('retry-after'), /^\d+$/);
  assert.equal(count(handle.database, 'display_session'), 0);

  assert.equal((await bob.pairScreen(valid.code, 'Bob can pair')).status, 200);
});

test('pairing attempts are limited per owner per minute', http, async (t) => {
  const { alice } = await setup(t);
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    // Invalid names do not count as code failures, so only the attempt limit applies.
    statuses.push((await alice.pairScreen('ABCD-EFGH', '')).status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.equal(statuses[10], 429);
});

test('challenge creation and polling are rate limited', http, async (t) => {
  const { handle } = await setup(t, { trustedIpHeader: TRUSTED_IP_HEADER });
  const firstAddress = { [TRUSTED_IP_HEADER]: '192.0.2.10' };
  const secondAddress = { [TRUSTED_IP_HEADER]: '192.0.2.11' };

  const tv = createBrowser(handle.origin);
  for (let request = 0; request < 6; request += 1) {
    assert.equal((await tv.createTvChallenge(firstAddress)).status, 201);
  }
  const limited = await tv.createTvChallenge(firstAddress);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.equal((await tv.createTvChallenge(secondAddress)).status, 201, 'another address is fine');
  assert.equal(count(handle.database, 'pairing_challenge'), 1, 'one open challenge per TV page');

  let lastStatus = 0;
  let polls = 0;
  while (lastStatus !== 429 && polls < 60) {
    lastStatus = (await tv.pairingStatus(secondAddress)).status;
    polls += 1;
  }
  assert.equal(lastStatus, 429);
  assert.equal(polls, 41, 'forty polls per minute per challenge');
});

test('open challenges are capped so anonymous pages cannot fill the database', http, async (t) => {
  const { handle } = await setup(t);
  const insert = handle.database.prepare(
    `INSERT INTO pairing_challenge (id, secret_hash, code_hash, state, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  );
  const farFuture = Date.now() + 60_000;
  // Test fixture: rows that look like open challenges from other pages.
  for (let index = 0; index < MAX_OPEN_CHALLENGES; index += 1) {
    insert.run(`fixture-${index}`, 'a'.repeat(64), `fixture-code-${index}`, Date.now(), farFuture);
  }
  const refused = await createBrowser(handle.origin).createTvChallenge();
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error, 'busy');
  assert.equal(count(handle.database, 'pairing_challenge'), MAX_OPEN_CHALLENGES);
});

test('a workspace cannot hold more than the maximum number of screens', http, async (t) => {
  const { handle, alice } = await setup(t);
  const workspaceId = handle.database
    .prepare(
      'SELECT workspace.id AS id FROM workspace JOIN "user" ON "user".id = owner_user_id WHERE email = ?',
    )
    .get(ALICE).id;
  // Test fixture: sessions for other (unpaired, credential-less) TVs of the same workspace.
  for (let index = 0; index < MAX_SCREENS_PER_WORKSPACE; index += 1) {
    handle.database
      .prepare(
        `INSERT INTO display_session (id, secret_hash, workspace_id, name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `fixture-${index}`,
        'b'.repeat(64),
        workspaceId,
        `TV ${index}`,
        Date.now(),
        Date.now() + 60_000,
      );
  }
  const { code } = await newTv(handle);
  const refused = await alice.pairScreen(code, 'One too many');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'screen_limit');
});

// ---- Concurrency ----------------------------------------------------------------------------

test('parallel exchanges and parallel approvals each succeed exactly once', http, async (t) => {
  const { handle, alice, bob } = await setup(t);

  const contested = await newTv(handle);
  const approvals = await Promise.all([
    alice.pairScreen(contested.code, 'Alice wins?'),
    bob.pairScreen(contested.code, 'Bob wins?'),
    alice.pairScreen(contested.code, 'Alice again'),
    bob.pairScreen(contested.code, 'Bob again'),
  ]);
  assert.equal(approvals.filter((result) => result.status === 200).length, 1);
  assert.equal(approvals.filter((result) => result.status === 400).length, 3);

  const exchanges = await Promise.all(
    Array.from({ length: 6 }, () =>
      httpRequest({
        origin: handle.origin,
        pathname: '/api/tv/pairing/exchange',
        method: 'POST',
        headerLines: [
          `Origin: ${handle.origin}`,
          'Content-Type: application/json',
          `Cookie: ${contested.tv.cookieHeader()}`,
        ],
        body: '{}',
      }),
    ),
  );
  assert.equal(exchanges.filter((result) => result.status === 200).length, 1);
  assert.equal(exchanges.filter((result) => result.status === 404).length, 5);
  assert.equal(count(handle.database, 'display_session'), 1);

  const winnerIsAlice = approvals[0].status === 200 || approvals[2].status === 200;
  const winner = winnerIsAlice ? alice : bob;
  const loser = winnerIsAlice ? bob : alice;
  assert.equal((await winner.listScreens()).json.screens.length, 1);
  assert.equal((await loser.listScreens()).json.screens.length, 0);
});

// ---- Revocation, restart, expiry ------------------------------------------------------------

test('an owner revokes one screen and only that screen loses access', http, async (t) => {
  const { handle, alice } = await setup(t);
  const kitchen = await pairTv(handle, alice, 'Kitchen');
  const office = await pairTv(handle, alice, 'Office');
  const { screens } = (await alice.listScreens()).json;
  assert.deepEqual(
    screens.map((screen) => screen.name),
    ['Kitchen', 'Office'],
  );

  const revoked = await alice.revokeScreen(screens[0].id);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.json, { status: 'revoked' });

  const denied = await kitchen.loadDisplay();
  assert.equal(denied.status, 401);
  assert.match(cookieNamed(denied, 'metrictv_tv_display'), /Max-Age=0/);
  assert.equal(kitchen.cookies.has('metrictv_tv_display'), false);
  assert.deepEqual(denied.json, { error: 'unauthenticated' }, 'no private data after revoke');
  assert.equal((await office.loadDisplay()).status, 200);
  assert.deepEqual(
    (await alice.listScreens()).json.screens.map((screen) => screen.name),
    ['Office'],
  );
  assert.equal((await alice.revokeScreen(screens[0].id)).status, 404, 'revoking twice');
});

test("owners cannot list or revoke each other's screens", http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const aliceTv = await pairTv(handle, alice, 'Alice TV');
  await pairTv(handle, bob, 'Bob TV');
  const aliceScreen = (await alice.listScreens()).json.screens[0];
  const bobScreen = (await bob.listScreens()).json.screens[0];

  assert.deepEqual(
    (await alice.listScreens()).json.screens.map((screen) => screen.name),
    ['Alice TV'],
  );
  assert.deepEqual(
    (await bob.listScreens()).json.screens.map((screen) => screen.name),
    ['Bob TV'],
  );

  const crossRevoke = await bob.revokeScreen(aliceScreen.id);
  const unknownRevoke = await bob.revokeScreen('A'.repeat(22));
  assert.equal(crossRevoke.status, 404);
  assert.deepEqual(forgeStatus(crossRevoke), forgeStatus(unknownRevoke));
  assert.equal((await aliceTv.loadDisplay()).status, 200, "Alice's screen is untouched");
  assert.equal((await alice.revokeScreen(bobScreen.id)).status, 404);
  assert.equal((await bob.listScreens()).json.screens.length, 1);
});

test("each TV sees only its own workspace's appearance", http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const aliceTv = await pairTv(handle, alice, 'Alice TV');
  const bobTv = await pairTv(handle, bob, 'Bob TV');
  await alice.saveSettings({ theme: 'dark', period: 'today' }, 0);

  assert.deepEqual((await aliceTv.loadDisplay()).json.settings, { period: 'today', theme: 'dark' });
  assert.deepEqual((await bobTv.loadDisplay()).json.settings, { period: 'week', theme: 'light' });
  assert.equal((await bobTv.loadDisplay()).json.screen.name, 'Bob TV');
});

test('display sessions survive a restart and stop at their 30-day expiry', http, async (t) => {
  const { environment, handle, alice } = await setup(t);
  const tv = await pairTv(handle, alice, 'Lounge');
  const pending = await newTv(handle);
  await handle.close();

  const restarted = await startBetaServer(t, environment);
  assert.equal((await tv.loadDisplay()).status, 200, 'same cookie works after restart');
  assert.equal((await pending.tv.pairingStatus()).json.state, 'pending');
  const owner = await signInOwner(restarted, ALICE);
  assert.equal((await owner.browser.listScreens()).json.screens[0].name, 'Lounge');

  restarted.database.prepare('UPDATE display_session SET expires_at = ?').run(LONG_AGO);
  assert.equal((await tv.loadDisplay()).status, 401);
  assert.equal((await owner.browser.listScreens()).json.screens.length, 0);
});

test('a screen in use renews its pairing once a day, cookie included', http, async (t) => {
  const { handle, alice } = await setup(t);
  const tv = await pairTv(handle, alice, 'Kitchen');
  const expiryOf = () =>
    handle.database.prepare('SELECT expires_at FROM display_session').get().expires_at;

  // Freshly paired: nothing to renew yet, so no cookie is re-sent on every poll.
  const fresh = await tv.loadDisplay();
  assert.equal(fresh.status, 200);
  assert.equal(cookieNamed(fresh, 'metrictv_tv_display'), undefined);

  // Age the session (direct write): 10 days left. The next poll moves it back to 30 days.
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  handle.database.prepare('UPDATE display_session SET expires_at = ?').run(Date.now() + tenDaysMs);
  const renewed = await tv.loadDisplay();
  assert.equal(renewed.status, 200);
  const renewedCookie = cookieNamed(renewed, 'metrictv_tv_display');
  assert.match(renewedCookie, new RegExp(`Max-Age=${THIRTY_DAYS_SECONDS}\\b`));
  assert.match(renewedCookie, /HttpOnly/i);
  assert.match(renewedCookie, /SameSite=Strict/i);
  const twentyNineDaysMs = 29 * 24 * 60 * 60 * 1000;
  assert.ok(expiryOf() > Date.now() + twentyNineDaysMs, 'expiry is a full 30 days ahead again');

  // Within the same day there is no further write or cookie.
  const expiryAfterRenewal = expiryOf();
  const again = await tv.loadDisplay();
  assert.equal(cookieNamed(again, 'metrictv_tv_display'), undefined);
  assert.equal(expiryOf(), expiryAfterRenewal);

  // Renewal never revives a removed screen.
  const screens = (await alice.listScreens()).json.screens;
  assert.equal((await alice.revokeScreen(screens[0].id)).status, 200);
  assert.equal((await tv.loadDisplay()).status, 401);
});

test("deleting an account's workspace removes its screens", http, async (t) => {
  const { handle, alice } = await setup(t);
  const tv = await pairTv(handle, alice, 'Gone soon');
  handle.database.prepare('DELETE FROM workspace').run();
  assert.equal(count(handle.database, 'display_session'), 0);
  assert.equal((await tv.loadDisplay()).status, 401);
});

// ---- Permissions ----------------------------------------------------------------------------

test(
  'a display session fails every owner endpoint and an owner session fails the display',
  http,
  async (t) => {
    const { handle, alice } = await setup(t);
    const tv = await pairTv(handle, alice, 'Wall');
    const displayCookie = tv.cookieHeader();
    const ownerHeaders = (extra) => [
      `Origin: ${handle.origin}`,
      'Content-Type: application/json',
      `Cookie: ${displayCookie}`,
      ...extra,
    ];

    const attempts = [
      { pathname: '/api/beta/session', method: 'GET' },
      { pathname: '/api/beta/screens', method: 'GET' },
      {
        pathname: '/api/beta/settings',
        method: 'POST',
        body: '{"settings":{"theme":"dark"},"revision":0}',
      },
      {
        pathname: '/api/beta/screens/pair',
        method: 'POST',
        body: '{"code":"ABCD-EFGH","name":"x"}',
      },
      { pathname: '/api/beta/screens/revoke', method: 'POST', body: `{"id":"${'A'.repeat(22)}"}` },
      { pathname: '/api/auth/sign-out', method: 'POST', body: '{}' },
      { pathname: '/api/auth/get-session', method: 'GET' },
    ];
    for (const attempt of attempts) {
      const result = await httpRequest({
        origin: handle.origin,
        pathname: attempt.pathname,
        method: attempt.method,
        headerLines: ownerHeaders(['X-CSRF-Token: anything']),
        body: attempt.body,
      });
      assert.ok([401, 404].includes(result.status), `${attempt.pathname} -> ${result.status}`);
      assert.equal(result.text.includes('Wall'), false);
    }
    assert.equal(count(handle.database, 'display_session'), 1, 'nothing was changed');

    // The owner's own cookie is not a display credential.
    const ownerOnDisplay = await alice.loadDisplay();
    assert.equal(ownerOnDisplay.status, 401);
  },
);

test('state-changing pairing routes require exact origin, JSON and owner CSRF', http, async (t) => {
  const { handle, alice, bob } = await setup(t);
  const { tv, code } = await newTv(handle);

  const wrongOrigin = await alice.pairScreen(code, 'X', { Origin: 'https://evil.example.test' });
  assert.equal(wrongOrigin.status, 403);
  const crossSite = await alice.pairScreen(code, 'X', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const noCsrf = await alice.pairScreen(code, 'X', { 'X-CSRF-Token': '' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error, 'invalid_csrf');
  const othersCsrf = await alice.pairScreen(code, 'X', { 'X-CSRF-Token': bob.csrfToken });
  assert.equal(othersCsrf.status, 403);
  const textPlain = await alice.request('/api/beta/screens/pair', {
    method: 'POST',
    rawBody: JSON.stringify({ code, name: 'X' }),
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': alice.csrfToken },
  });
  assert.equal(textPlain.status, 415);
  const extraKey = await alice.request('/api/beta/screens/pair', {
    method: 'POST',
    body: { code, name: 'X', workspaceId: 'someone-else' },
    headers: { 'X-CSRF-Token': alice.csrfToken },
  });
  assert.equal(extraKey.status, 400);
  const anonymous = await createBrowser(handle.origin).request('/api/beta/screens/pair', {
    method: 'POST',
    body: { code, name: 'X' },
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await createBrowser(handle.origin).request('/api/beta/screens')).status, 401);
  assert.ok(
    [404, 405].includes((await alice.request('/api/beta/screens/pair')).status),
    'GET never pairs',
  );
  assert.ok([404, 405].includes((await alice.request('/api/beta/screens/revoke')).status));
  assert.equal((await alice.revokeScreen('A'.repeat(22), { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await alice.revokeScreen('short')).status, 400);

  // Nothing above consumed the code.
  assert.equal((await tv.pairingStatus()).json.state, 'pending');
  assert.equal((await alice.pairScreen(code, 'Finally')).status, 200);

  // TV routes: exact origin and JSON as well.
  const anotherTv = createBrowser(handle.origin);
  assert.equal(
    (await anotherTv.createTvChallenge({ Origin: 'https://evil.example.test' })).status,
    403,
  );
  assert.equal((await tv.exchangePairing({ Origin: 'null' })).status, 403);
  assert.equal((await tv.exchangePairing({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(count(handle.database, 'display_session'), 0);
});

test('GET requests never change pairing state', http, async (t) => {
  const { handle, alice } = await setup(t);
  const tv = await pairTv(handle, alice, 'Quiet');
  const waiting = await newTv(handle);
  const snapshot = () =>
    JSON.stringify([
      handle.database.prepare('SELECT * FROM pairing_challenge ORDER BY id').all(),
      handle.database
        .prepare('SELECT id, name, expires_at, workspace_id FROM display_session ORDER BY id')
        .all(),
    ]);
  const before = snapshot();

  await waiting.tv.pairingStatus();
  await tv.loadDisplay();
  await alice.listScreens();
  for (const pathname of [
    '/api/tv/challenge',
    '/api/tv/pairing/exchange',
    '/api/beta/screens/pair',
  ]) {
    const result = await alice.request(pathname);
    assert.ok([404, 405].includes(result.status), pathname);
  }
  assert.equal(snapshot(), before);
});

test(
  'malformed credentials are refused: duplicates, junk and oversized cookies',
  http,
  async (t) => {
    const { handle, alice } = await setup(t);
    const tv = await pairTv(handle, alice, 'Strict');
    const good = tv.cookieHeader();
    const send = (headerLines) =>
      httpRequest({ origin: handle.origin, pathname: '/api/display', headerLines });

    assert.equal((await send([`Cookie: ${good}`])).status, 200);
    assert.equal((await send([`Cookie: ${good}`, `Cookie: ${good}`])).status, 401);
    assert.equal((await send([`Cookie: ${good}; ${good}`])).status, 401);
    assert.equal((await send(['Cookie: metrictv_tv_display=junk'])).status, 401);
    assert.equal((await send([`Cookie: metrictv_tv_display=${'A'.repeat(4000)}`])).status, 401);
    assert.equal((await send(['Cookie: metrictv_tv_display='])).status, 401);
    assert.equal((await send([])).status, 401);
  },
);

test('screen names are bounded and plain', http, async (t) => {
  const { handle, alice } = await setup(t);
  const { tv, code } = await newTv(handle);
  const invalidNames = [
    '',
    '   ',
    'x'.repeat(41),
    '<b>tv</b>',
    'tv\nname',
    '-leading',
    'a\u0000b',
    5,
    null,
  ];
  for (const name of invalidNames) {
    const result = await alice.pairScreen(code, name);
    assert.equal(result.status, 400, JSON.stringify(name));
    assert.equal(result.json.error, 'invalid_name');
  }
  assert.equal((await tv.pairingStatus()).json.state, 'pending', 'bad names do not use the code');
  const accepted = await alice.pairScreen(code, ` ${'é'.repeat(39)}1 `);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.name.length, 40);
});

// ---- Pages, https cookies, schema ------------------------------------------------------------

test('the beta server serves /tv and its scripts; the demo server does not', http, async (t) => {
  const { handle } = await setup(t);
  const browser = createBrowser(handle.origin);
  for (const pathname of [
    '/tv',
    '/tv/tv.html',
    '/tv/tv.js',
    '/tv/tv-client.js',
    '/tv/tv-view.js',
  ]) {
    const result = await browser.request(pathname);
    assert.equal(result.status, 200, pathname);
    assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const page = (await browser.request('/tv')).text;
  assert.match(page, /\/tv\.js/);
  assert.equal(
    /localStorage|sessionStorage/.test((await browser.request('/tv/tv.js')).text),
    false,
  );

  const demo = createDemoHandler();
  for (const pathname of ['/tv/tv.html', '/tv/tv.js', '/tv/tv-client.js', '/tv/tv-view.js']) {
    let status;
    await demo(
      { method: 'GET', url: pathname },
      {
        writeHead(code) {
          status = code;
        },
        end() {},
      },
    );
    assert.equal(status, 404, pathname);
  }
});

test(
  'an https origin gives __Host- prefixed Secure cookies for both TV credentials',
  http,
  async (t) => {
    const environment = await createBetaEnvironment(t, { invites: [ALICE] });
    const httpsOrigin = 'https://beta.example.test';
    const handle = await startBetaServer(t, { ...environment, origin: httpsOrigin });
    const headerLines = [
      'Host: beta.example.test',
      `Origin: ${httpsOrigin}`,
      'Content-Type: application/json',
    ];
    const created = await httpRequest({
      origin: environment.origin,
      pathname: '/api/tv/challenge',
      method: 'POST',
      headerLines,
      body: '{}',
    });
    assert.equal(created.status, 201);
    assert.ok(created.headers.get('strict-transport-security'));
    const challengeCookie = created.headers.getSetCookie()[0];
    assert.match(challengeCookie, /^__Host-metrictv_tv_challenge=/);
    for (const attribute of [/; Secure/i, /HttpOnly/i, /SameSite=Strict/i, /Path=\//]) {
      assert.match(challengeCookie, attribute);
    }
    assert.equal(/Domain=/i.test(challengeCookie), false);

    // Approve with the store function: an owner session over https is not needed for cookie checks.
    const { id: workspaceId } = handle.database.prepare('SELECT id FROM workspace').get();
    const code = created.json.code.replace('-', '');
    assert.equal(
      approveChallenge(handle.database, { workspaceId, code, screenName: 'Secure TV' }),
      'ok',
    );
    const challengeValue = challengeCookie.split(';')[0];
    const exchanged = await httpRequest({
      origin: environment.origin,
      pathname: '/api/tv/pairing/exchange',
      method: 'POST',
      headerLines: [...headerLines, `Cookie: ${challengeValue}`],
      body: '{}',
    });
    assert.equal(exchanged.status, 200);
    const displayCookie = exchanged.headers
      .getSetCookie()
      .find((entry) => entry.includes('display'));
    assert.match(displayCookie, /^__Host-metrictv_tv_display=/);
    assert.match(displayCookie, /; Secure/i);
    assert.match(displayCookie, /HttpOnly/i);
    assert.match(displayCookie, /SameSite=Strict/i);
  },
);

test('a version 1 database is refused until migrated, then keeps its data', http, async (t) => {
  const environment = await createBetaEnvironment(t, { invites: [ALICE] });
  const { databasePath, secret, origin } = environment;
  const database = openInitializedDatabase(databasePath);
  database.exec(
    'DROP TABLE pairing_challenge; DROP TABLE display_session; PRAGMA user_version = 1',
  );
  database.close();

  assert.throws(
    () => openInitializedDatabase(databasePath),
    (error) => error instanceof AccountError && error.code === 'schema_not_current',
  );
  await migrateDatabase({ databasePath, secret, origin });
  await migrateDatabase({ databasePath, secret, origin });

  const migrated = openInitializedDatabase(databasePath);
  assert.equal(count(migrated, 'pairing_challenge'), 0);
  assert.equal(count(migrated, 'display_session'), 0);
  assert.equal(count(migrated, 'workspace'), 1, 'owners and workspaces are kept');
  migrated.exec('PRAGMA user_version = 99');
  migrated.close();
  await assert.rejects(migrateDatabase({ databasePath, secret, origin }), /newer MetricTV/);
  assert.throws(() => openInitializedDatabase(databasePath), /schema_not_current/);
});

// ---- Units ----------------------------------------------------------------------------------

test('code and screen name parsing', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' ab cd  ef gh '), 'ABCDEFGH');
  for (const bad of [
    '',
    'ABCD-EFG',
    'ABCD-EFGH1',
    'ABCD-EFG0',
    'ABCD-EFGO',
    '<script>',
    null,
    12345678,
  ]) {
    assert.equal(normalizeCode(bad), null, String(bad));
  }
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(parseScreenName('  Living room  '), 'Living room');
  assert.equal(parseScreenName("Dad's TV 2"), "Dad's TV 2");
  for (const bad of ['', ' ', 'x'.repeat(41), '<img>', 'a/b', 'a\tb', '.hidden', {}, undefined]) {
    assert.equal(parseScreenName(bad), null, String(bad));
  }
});

test('the rate limiter counts per key and fails closed when full', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 2 });
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.peek('a').allowed, true, 'peek does not count');
  assert.equal(limiter.consume('a').allowed, true);
  const refused = limiter.consume('a');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
  assert.equal(limiter.peek('a').allowed, false);
  assert.equal(limiter.consume('b').allowed, true, 'other keys are independent');
  assert.equal(limiter.consume('c').allowed, false, 'a full table refuses new keys');
  assert.equal(limiter.peek('never-seen').allowed, true);
});
