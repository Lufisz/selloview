// Small DOM controllers for the sample app: toast, dialog and full screen. Browser only;
// demo.js creates them once and calls them from its event handlers.
import { escapeHtml } from '../shared/format.js';

/** Toast message box. */
export function createToast(element, durationMs = 3500) {
  let timer;
  return function showToast(message) {
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('visible'), durationMs);
  };
}

/**
 * Modal dialog with a heading and paragraphs. Content is escaped text.
 * Focus returns to the trigger, or to the same data-action if a re-render replaced it.
 */
export function createDialog({ dialog, content, closeButton }) {
  let trigger = null;
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const action = trigger?.dataset?.action;
    const replacement = action
      ? document.querySelector(`[data-action="${CSS.escape(action)}"]`)
      : null;
    const target = trigger?.isConnected ? trigger : replacement;
    target?.focus();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });
  return {
    open({ eyebrow = '', title, paragraphs, opener = document.activeElement }) {
      trigger = opener;
      const eyebrowHtml = eyebrow ? `<span class="eyebrow">${escapeHtml(eyebrow)}</span>` : '';
      const paragraphHtml = paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
      content.innerHTML = `${eyebrowHtml}<h2 id="dialog-title">${escapeHtml(title)}</h2>${paragraphHtml}`;
      dialog.showModal();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}

/** Toggles browser full screen. Resolves false when the browser refuses. */
export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}
