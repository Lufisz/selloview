import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAttentionPanel, renderOrdersPanel } from '../../public/shared/board.js';

test('an attention panel without items shows its escaped empty text and a zero count', () => {
  const html = renderAttentionPanel({
    title: 'Needs attention',
    items: [],
    emptyText: 'Nothing <b>needs</b> attention',
  });
  assert.match(html, /Nothing &lt;b&gt;needs&lt;\/b&gt; attention/);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /<span class="count">0<\/span>/);
});

test('an orders panel without rows shows its escaped empty text instead of a table', () => {
  const html = renderOrdersPanel({
    title: 'Latest orders',
    columns: [{ label: 'Order' }],
    rows: [],
    emptyText: 'No <i>orders</i> yet',
  });
  assert.match(html, /No &lt;i&gt;orders&lt;\/i&gt; yet/);
  assert.equal(html.includes('<i>'), false);
  assert.equal(html.includes('<table'), false);
});

test('the empty-state text has a rule in the shared board stylesheet, whichever page shows it', async () => {
  const html = renderOrdersPanel({
    title: 'Latest orders',
    columns: [{ label: 'Order' }],
    rows: [],
    emptyText: 'No orders yet',
  });
  const emptyClass = html.match(/<p class="([^"]+)">No orders yet/)[1];
  const boardCss = await readFile(
    new URL('../../public/shared/board.css', import.meta.url),
    'utf8',
  );
  assert.match(boardCss, new RegExp(`\\.${emptyClass}\\s*\\{`));
});
