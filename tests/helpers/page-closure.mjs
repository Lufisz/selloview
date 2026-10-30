// The files a page loads: its HTML, the scripts, stylesheets and images that HTML names, the
// modules those scripts import and the files their stylesheets reference. Used to tie the lists of
// servable files to what the pages really load. Plain text matching is enough here: the pages use
// static imports and quoted URLs only.
import fs from 'node:fs';
import path from 'node:path';

const HTML_REFERENCES = [
  /<script\b[^>]*\bsrc="([^"#?]+)/g,
  /<link\b[^>]*\bhref="([^"#?]+)/g,
  /<img\b[^>]*\bsrc="([^"#?]+)/g,
];
const SCRIPT_REFERENCES = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g];
const STYLE_REFERENCES = [/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, /@import\s+['"]([^'"]+)['"]/g];
const REFERENCE_PATTERNS = {
  '.html': HTML_REFERENCES,
  '.js': SCRIPT_REFERENCES,
  '.css': STYLE_REFERENCES,
};
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

function referencedPaths(publicPath, text) {
  const patterns = REFERENCE_PATTERNS[path.posix.extname(publicPath)] ?? [];
  const referenced = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (EXTERNAL_URL.test(match[1])) continue;
      const directory = path.posix.dirname(publicPath);
      referenced.push(match[1].startsWith('/') ? match[1] : path.posix.join(directory, match[1]));
    }
  }
  return referenced;
}

/**
 * Every public path loaded by the page at `pagePath` (such as '/demo/demo.html'), sorted.
 * Throws when something the page references is missing from `publicDir`.
 */
export function pageClosure(publicDir, pagePath) {
  const seen = new Set();
  const pending = [pagePath];
  while (pending.length > 0) {
    const publicPath = pending.pop();
    if (seen.has(publicPath)) continue;
    seen.add(publicPath);
    const filePath = path.join(publicDir, ...publicPath.split('/'));
    if (!fs.existsSync(filePath)) throw new Error(`${publicPath} is loaded but does not exist`);
    pending.push(...referencedPaths(publicPath, fs.readFileSync(filePath, 'utf8')));
  }
  return [...seen].sort();
}
