import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialog, createToast, toggleFullscreen } from '../../public/demo/demo-controls.js';

// Replaces globals such as `document` for one test and restores them afterwards.
function stubGlobals(context, values) {
  for (const [name, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    context.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
}

function fakeClassList() {
  const names = new Set();
  return {
    add: (name) => names.add(name),
    remove: (name) => names.delete(name),
    has: (name) => names.has(name),
  };
}

test('a toast shows its message and hides it after the delay; a newer message restarts the delay', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = { textContent: '', classList: fakeClassList() };
  const showToast = createToast(element, 1000);

  showToast('Saved');
  assert.equal(element.textContent, 'Saved');
  assert.equal(element.classList.has('visible'), true);
  context.mock.timers.tick(999);
  assert.equal(element.classList.has('visible'), true);
  context.mock.timers.tick(1);
  assert.equal(element.classList.has('visible'), false);

  showToast('One');
  context.mock.timers.tick(600);
  showToast('Two');
  context.mock.timers.tick(600);
  assert.equal(element.textContent, 'Two');
  assert.equal(element.classList.has('visible'), true, 'the first timer was cancelled');
  context.mock.timers.tick(400);
  assert.equal(element.classList.has('visible'), false);
});

// A dialog element and its close button that record what the controller registers.
function fakeDialogParts() {
  const dialogListeners = {};
  const closeButtonListeners = {};
  const dialog = {
    open: false,
    bounds: { left: 100, right: 300, top: 100, bottom: 300 },
    addEventListener: (type, handler) => (dialogListeners[type] = handler),
    showModal: () => (dialog.open = true),
    close: () => {
      dialog.open = false;
      dialogListeners.close?.();
    },
    getBoundingClientRect: () => dialog.bounds,
  };
  const closeButton = {
    addEventListener: (type, handler) => (closeButtonListeners[type] = handler),
  };
  const content = { innerHTML: '' };
  return { dialog, dialogListeners, closeButton, closeButtonListeners, content };
}

test('a dialog shows escaped text and closes from its button or a click outside its box', () => {
  const parts = fakeDialogParts();
  const controller = createDialog(parts);
  assert.equal(controller.isOpen, false);

  controller.open({
    eyebrow: 'A & B',
    title: '<b>Title</b>',
    paragraphs: ['one <i>x</i>', 'two'],
    opener: null,
  });
  assert.equal(controller.isOpen, true);
  assert.equal(parts.content.innerHTML.includes('<b>'), false);
  assert.equal(parts.content.innerHTML.includes('<i>'), false);
  assert.match(parts.content.innerHTML, /<span class="eyebrow">A &amp; B<\/span>/);
  assert.match(parts.content.innerHTML, /<h2 id="dialog-title">&lt;b&gt;Title&lt;\/b&gt;<\/h2>/);
  assert.match(parts.content.innerHTML, /<p>one &lt;i&gt;x&lt;\/i&gt;<\/p><p>two<\/p>/);

  const clickAt = (x, y, target = parts.dialog) =>
    parts.dialogListeners.click({ target, clientX: x, clientY: y });
  clickAt(200, 200); // inside the box
  assert.equal(controller.isOpen, true);
  clickAt(200, 200, { not: 'the dialog' }); // a click on its content
  assert.equal(controller.isOpen, true);
  clickAt(50, 200); // the backdrop to the left
  assert.equal(controller.isOpen, false);

  controller.open({ title: 'Again', paragraphs: [], opener: null });
  parts.closeButtonListeners.click();
  assert.equal(controller.isOpen, false);

  for (const [x, y] of [
    [350, 200],
    [200, 50],
    [200, 350],
  ]) {
    controller.open({ title: 'Edge', paragraphs: [], opener: null });
    clickAt(x, y);
    assert.equal(controller.isOpen, false, `a click at ${x},${y} is outside`);
  }
});

test('closing a dialog returns focus to its trigger, or to the same action after a re-render', (context) => {
  const lookups = [];
  const replacement = { focused: false, focus: () => (replacement.focused = true) };
  stubGlobals(context, {
    CSS: { escape: (value) => value },
    document: {
      activeElement: null,
      querySelector: (selector) => {
        lookups.push(selector);
        return replacement;
      },
    },
  });

  const parts = fakeDialogParts();
  const controller = createDialog(parts);

  const liveTrigger = { isConnected: true, dataset: {}, focused: false };
  liveTrigger.focus = () => (liveTrigger.focused = true);
  controller.open({ title: 'T', paragraphs: [], opener: liveTrigger });
  parts.dialog.close();
  assert.equal(liveTrigger.focused, true);
  assert.deepEqual(lookups, [], 'a trigger that is still on the page is used as it is');

  const staleTrigger = { isConnected: false, dataset: { action: 'show-help' }, focus: () => {} };
  controller.open({ title: 'T', paragraphs: [], opener: staleTrigger });
  parts.dialog.close();
  assert.deepEqual(lookups, ['[data-action="show-help"]']);
  assert.equal(replacement.focused, true);

  controller.open({ title: 'T', paragraphs: [], opener: null });
  assert.doesNotThrow(() => parts.dialog.close(), 'no trigger means nothing to focus');
});

test('toggleFullscreen enters and leaves full screen, and reports a refusal', async (context) => {
  const calls = [];
  const fakeDocument = {
    fullscreenElement: null,
    exitFullscreen: async () => calls.push('exit'),
    documentElement: { requestFullscreen: async () => calls.push('enter') },
  };
  stubGlobals(context, { document: fakeDocument });

  assert.equal(await toggleFullscreen(), true);
  fakeDocument.fullscreenElement = {};
  assert.equal(await toggleFullscreen(), true);
  assert.deepEqual(calls, ['enter', 'exit']);

  fakeDocument.fullscreenElement = null;
  fakeDocument.documentElement.requestFullscreen = async () => {
    throw new TypeError('refused');
  };
  assert.equal(await toggleFullscreen(), false);
});
