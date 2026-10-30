import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAttentionPanel, renderOrdersPanel } from '../../public/board.js';

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
