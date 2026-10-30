// The rules for where private data may live and how it must look on disk. The database file and
// the Shopify grant files both depend on them.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_ROOT,
  isCleanAbsolutePath,
  isInside,
  isPrivate,
} from '../../server/private-files.mjs';

test('a configured path must be absolute, already normalized and free of NUL bytes', () => {
  assert.equal(isCleanAbsolutePath('/var/lib/metrictv/metrictv.sqlite'), true);

  const refused = [
    'metrictv.sqlite',
    './metrictv.sqlite',
    '/var/lib/../lib/metrictv.sqlite',
    '/var/lib//metrictv.sqlite',
    '/var/lib/./metrictv.sqlite',
    '/var/lib/metrictv\0.sqlite',
    '',
    undefined,
    42,
  ];
  for (const candidate of refused) {
    assert.equal(isCleanAbsolutePath(candidate), false, String(candidate));
  }
});

test('inside means the directory itself or something below it, not a name that merely starts alike', () => {
  assert.equal(isInside('/srv/app', '/srv/app'), true);
  assert.equal(isInside('/srv/app', '/srv/app/public/index.html'), true);
  assert.equal(isInside('/srv/app', '/srv/application'), false);
  assert.equal(isInside('/srv/app', '/srv'), false);
});

test('the project root is the folder that holds server/ and public/', () => {
  assert.ok(isInside(PROJECT_ROOT, `${PROJECT_ROOT}/public`));
  assert.equal(isInside(PROJECT_ROOT, '/definitely/not/the/project'), false);
});

test('private means owned by the server user, with no access for group or others', () => {
  const userId = typeof process.getuid === 'function' ? process.getuid() : 0;
  assert.equal(isPrivate({ uid: userId, mode: 0o100600 }), true, 'a file only we can use');
  assert.equal(isPrivate({ uid: userId, mode: 0o040700 }), true, 'a directory only we can use');
  assert.equal(isPrivate({ uid: userId, mode: 0o100640 }), false, 'group can read');
  assert.equal(isPrivate({ uid: userId, mode: 0o100604 }), false, 'others can read');
  assert.equal(isPrivate({ uid: userId, mode: 0o040750 }), false, 'group can enter');
  if (typeof process.getuid === 'function') {
    assert.equal(isPrivate({ uid: userId + 1, mode: 0o100600 }), false, 'someone else owns it');
  }
});
