// Each server may serve only the files listed for it in server/http/public-files.mjs, so a file
// added to public/ stays private until someone lists it. These tests tie the lists to what the
// pages really load: a list cannot silently grow, shrink or point at a missing file.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_PAGES,
  APP_PUBLIC_FILES,
  DEMO_PAGES,
  DEMO_PUBLIC_FILES,
} from '../../server/http/public-files.mjs';
import { pageClosure } from '../helpers/page-closure.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

function filesLoadedBy(pages) {
  const loaded = new Set();
  for (const pageFile of Object.values(pages)) {
    for (const file of pageClosure(PUBLIC_DIR, pageFile)) loaded.add(file);
  }
  return [...loaded].sort();
}

test('the sample server may serve exactly the files the demo page loads', () => {
  assert.deepEqual([...DEMO_PUBLIC_FILES].sort(), filesLoadedBy(DEMO_PAGES));
});

test('the app may serve exactly the files its pages load', () => {
  assert.deepEqual([...APP_PUBLIC_FILES].sort(), filesLoadedBy(APP_PAGES));
});

test('the app serves everything the sample server does, and the sample server nothing of the app', () => {
  for (const file of DEMO_PUBLIC_FILES) assert.ok(APP_PUBLIC_FILES.has(file), file);
  for (const ownerOnlyFile of ['/owner/owner.html', '/tv/tv.html', '/landing/landing.html']) {
    assert.equal(DEMO_PUBLIC_FILES.has(ownerOnlyFile), false, ownerOnlyFile);
  }
});
