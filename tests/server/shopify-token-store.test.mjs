// Synthetic grants only: no real Shopify credentials or responses appear in this file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createTokenStore } from '../../server/shopify/token-store.mjs';

const STORE = 'synthetic-test-store.myshopify.com';
const CLIENT_ID = 'synthetic_client_id_0001';
const KEY = crypto.randomBytes(32);
const NOW = Date.now();

let scratch;
before(async () => {
  // The store refuses a directory reached through a symlink, and os.tmpdir() is one on macOS.
  scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'selloview-store-'));
});
after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function grant(overrides = {}) {
  return {
    shop: STORE,
    clientId: CLIENT_ID,
    offline: true,
    scopes: ['read_all_orders', 'read_orders', 'read_products', 'read_inventory'],
    accessToken: 'synthetic_access_token',
    accessTokenExpiresAt: NOW + 3600_000,
    refreshToken: 'synthetic_refresh_token',
    refreshTokenExpiresAt: NOW + 86_400_000,
    savedAt: NOW,
    ...overrides,
  };
}

async function newStore(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(scratch, 'case-'));
  const filePath = path.join(directory, 'private', 'grant.json');
  const store = createTokenStore({
    filePath,
    key: KEY,
    clientId: CLIENT_ID,
    store: STORE,
    ...overrides,
  });
  return { directory, filePath, store };
}

describe('encrypted token store', () => {
  test('disconnect invalidates saves and replacements already inside an atomic write', async (context) => {
    const originalRename = fs.rename.bind(fs);
    for (const operation of ['save', 'replace']) {
      const { filePath, store } = await newStore();
      await store.replace(grant(), store.epoch);
      let entered;
      let release;
      const writeEntered = new Promise((resolve) => {
        entered = resolve;
      });
      const resumeWrite = new Promise((resolve) => {
        release = resolve;
      });
      const interceptedRename = context.mock.method(fs, 'rename', async (source, destination) => {
        if (destination === filePath) {
          entered();
          await resumeWrite;
        }
        return originalRename(source, destination);
      });
      const writing = store[operation](grant({ accessToken: 'synthetic_late_token' }), store.epoch);
      await writeEntered;
      const removing = store.remove();
      release();
      await assert.rejects(writing, { code: 'stale_write' });
      await removing;
      assert.equal(await store.load(), null);
      interceptedRename.mock.restore();
    }
  });

  test('round-trips across instances, encrypted with private modes', async () => {
    const { filePath, store } = await newStore();
    assert.equal(await store.load(), null);
    await store.replace(grant(), store.epoch);
    const disk = await fs.readFile(filePath, 'utf8');
    assert.ok(!disk.includes('synthetic_access_token'));
    assert.ok(!disk.includes('synthetic_refresh_token'));
    assert.ok(!disk.includes(STORE));
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o777, 0o700);
    const second = createTokenStore({ filePath, key: KEY, clientId: CLIENT_ID, store: STORE });
    assert.deepEqual(await second.load(), grant());
    const leftovers = (await fs.readdir(path.dirname(filePath))).filter((name) =>
      name.endsWith('.tmp'),
    );
    assert.deepEqual(leftovers, []);
  });

  test('uses a fresh random IV for every write', async () => {
    const { filePath, store } = await newStore();
    await store.replace(grant(), store.epoch);
    const first = JSON.parse(await fs.readFile(filePath, 'utf8')).iv;
    await store.save(grant(), store.epoch);
    const second = JSON.parse(await fs.readFile(filePath, 'utf8')).iv;
    assert.notEqual(first, second);
  });

  test('fails closed for wrong key, other client, other store and tampering', async () => {
    const { filePath, store } = await newStore();
    await store.replace(grant(), store.epoch);
    const variants = [
      { key: crypto.randomBytes(32) },
      { clientId: 'another_client_id_0002' },
      { store: 'another-store.myshopify.com' },
    ];
    for (const variant of variants) {
      const other = createTokenStore({
        filePath,
        key: KEY,
        clientId: CLIENT_ID,
        store: STORE,
        ...variant,
      });
      await assert.rejects(other.load(), { code: 'token_store' });
    }
    const envelope = JSON.parse(await fs.readFile(filePath, 'utf8'));
    for (const field of ['tag', 'data', 'iv']) {
      const tampered = {
        ...envelope,
        [field]: Buffer.from(envelope[field], 'base64').reverse().toString('base64'),
      };
      await fs.writeFile(filePath, JSON.stringify(tampered), { mode: 0o600 });
      await assert.rejects(store.load(), { code: 'token_store' });
    }
    await fs.writeFile(filePath, '{not json', { mode: 0o600 });
    await assert.rejects(store.load(), { code: 'token_store' });
  });

  test('rejects invalid grants on save and on reload', async () => {
    const { store } = await newStore();
    const invalid = [
      grant({ shop: 'other.myshopify.com' }),
      grant({ clientId: 'someone_else_0002' }),
      grant({ offline: false }),
      grant({ scopes: ['read_orders'] }),
      grant({
        scopes: [
          'read_all_orders',
          'read_orders',
          'read_products',
          'read_inventory',
          'write_orders',
        ],
      }),
      grant({ refreshToken: '' }),
      grant({ accessToken: 'has space' }),
      grant({ accessTokenExpiresAt: 'soon' }),
      grant({ refreshTokenExpiresAt: NOW + 10 * 365 * 86_400_000 }),
    ];
    for (const candidate of invalid) {
      await assert.rejects(store.replace(candidate, store.epoch), { code: 'invalid_grant' });
    }
    assert.equal(await store.load(), null);
  });

  test('refuses symlink files, loose permissions, hard links and unsafe directories', async () => {
    const symlinkCase = await newStore();
    await fs.mkdir(path.dirname(symlinkCase.filePath), { mode: 0o700 });
    const target = path.join(symlinkCase.directory, 'target.json');
    await fs.writeFile(target, 'precious', { mode: 0o600 });
    await fs.symlink(target, symlinkCase.filePath);
    await assert.rejects(symlinkCase.store.load(), { code: 'token_store' });
    await assert.rejects(symlinkCase.store.replace(grant(), 0), { code: 'token_store' });
    assert.equal(await fs.readFile(target, 'utf8'), 'precious');

    const looseFile = await newStore();
    await looseFile.store.replace(grant(), 0);
    await fs.chmod(looseFile.filePath, 0o644);
    await assert.rejects(looseFile.store.load(), { code: 'token_store' });

    const hardLink = await newStore();
    await hardLink.store.replace(grant(), 0);
    await fs.link(hardLink.filePath, path.join(hardLink.directory, 'alias'));
    await assert.rejects(hardLink.store.load(), { code: 'token_store' });

    const looseDirectory = await newStore();
    await fs.mkdir(path.dirname(looseDirectory.filePath), { mode: 0o755 });
    await fs.chmod(path.dirname(looseDirectory.filePath), 0o755);
    await assert.rejects(looseDirectory.store.replace(grant(), 0), { code: 'token_store' });
    await assert.rejects(looseDirectory.store.load(), { code: 'token_store' });

    const linkedDirectory = await newStore();
    const realDirectory = path.join(linkedDirectory.directory, 'real');
    await fs.mkdir(realDirectory, { mode: 0o700 });
    await fs.symlink(realDirectory, path.dirname(linkedDirectory.filePath));
    await assert.rejects(linkedDirectory.store.replace(grant(), 0), { code: 'token_store' });
    assert.deepEqual(await fs.readdir(realDirectory), []);
  });

  test('never overwrites or deletes a file that is not a token store', async () => {
    const { filePath, store } = await newStore();
    await fs.mkdir(path.dirname(filePath), { mode: 0o700 });
    await fs.writeFile(filePath, 'unrelated user data', { mode: 0o600 });
    await assert.rejects(store.replace(grant(), 0), { code: 'token_store' });
    await assert.rejects(store.remove(), { code: 'token_store' });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'unrelated user data');
  });

  test('rejects oversized files without reading them whole', async () => {
    const { filePath, store } = await newStore();
    await fs.mkdir(path.dirname(filePath), { mode: 0o700 });
    await fs.writeFile(filePath, 'x'.repeat(64 * 1024), { mode: 0o600 });
    await assert.rejects(store.load(), { code: 'token_store' });
  });

  test('stale epochs cannot write after remove or replace', async () => {
    const { filePath, store } = await newStore();
    await store.replace(grant(), store.epoch);
    const refreshEpoch = store.epoch;
    const removal = store.remove();
    await assert.rejects(store.save(grant({ accessToken: 'late_write_token' }), refreshEpoch), {
      code: 'stale_write',
    });
    await removal;
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
    assert.equal(await store.load(), null);

    await store.replace(grant(), store.epoch);
    const olderEpoch = store.epoch;
    await store.replace(grant({ accessToken: 'newer_lineage_token' }), store.epoch);
    await assert.rejects(store.save(grant({ accessToken: 'old_lineage_token' }), olderEpoch), {
      code: 'stale_write',
    });
    assert.equal((await store.load()).accessToken, 'newer_lineage_token');
  });

  test('serializes concurrent writes and remove of a missing file is fine', async () => {
    const { store } = await newStore();
    await store.remove();
    await store.replace(grant(), store.epoch);
    const epoch = store.epoch;
    await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        store.save(grant({ accessToken: `synthetic_token_${index}` }), epoch),
      ),
    );
    assert.equal((await store.load()).accessToken, 'synthetic_token_5');
  });

  test('constructor rejects relative paths and wrong key sizes', () => {
    assert.throws(
      () => createTokenStore({ filePath: 'rel.json', key: KEY, clientId: CLIENT_ID, store: STORE }),
      { code: 'token_store' },
    );
    assert.throws(
      () =>
        createTokenStore({
          filePath: '/tmp/x/../y.json',
          key: KEY,
          clientId: CLIENT_ID,
          store: STORE,
        }),
      { code: 'token_store' },
    );
    assert.throws(
      () =>
        createTokenStore({
          filePath: '/tmp/y.json',
          key: Buffer.alloc(16),
          clientId: CLIENT_ID,
          store: STORE,
        }),
      { code: 'token_store' },
    );
  });
});
