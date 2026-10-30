import test from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, sha256Hex } from '../../server/hashing.mjs';

test('sha256Hex is the lowercase hex SHA-256 of the text', () => {
  // Standard test vector for "abc".
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(sha256Hex('').length, 64);
});

test('constantTimeEqual accepts only identical strings, whatever their length or characters', () => {
  assert.equal(constantTimeEqual('token-value', 'token-value'), true);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('token-value', 'token-valuf'), false);
  assert.equal(constantTimeEqual('token-value', 'token-valu'), false);
  assert.equal(constantTimeEqual('token-valu', 'token-value'), false);
  assert.equal(constantTimeEqual('TOKEN-VALUE', 'token-value'), false);
  assert.equal(constantTimeEqual('tökén', 'tökén'), true);
  assert.equal(constantTimeEqual('tökén', 'token'), false);
});
