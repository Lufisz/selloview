import test from 'node:test';
import assert from 'node:assert/strict';
import { logEvent } from '../../server/log.mjs';

function captureLogLines(t) {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  return lines;
}

test('logEvent writes one JSON line with the time, the event and the given fields', (t) => {
  const lines = captureLogLines(t);

  logEvent('refresh_failed', { workspaceId: 'workspace-1', code: 'api_timeout' });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'refresh_failed');
  assert.equal(entry.workspaceId, 'workspace-1');
  assert.equal(entry.code, 'api_timeout');
  assert.ok(Number.isFinite(Date.parse(entry.time)));
});

test('a line break inside a field cannot forge a second log line', (t) => {
  const lines = captureLogLines(t);

  logEvent('request_failed', { error: 'Error\n{"event":"forged"}' });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('\n'), false);
  assert.equal(JSON.parse(lines[0]).event, 'request_failed');
});
