// Builds the sample dashboard as plain static files for any static host (GitHub Pages, Cloudflare
// Pages). It copies only the files the sample server may serve, so nothing private can slip in.
// Static hosts cannot send response headers, so the page carries its Content-Security-Policy itself.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_PUBLIC_FILES } from '../server/http/public-files.mjs';
import { DEMO_HEADERS } from '../server/demo.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, 'dist', 'demo-site');

// A <meta> policy cannot use frame-ancestors; browsers ignore it there.
function metaContentSecurityPolicy() {
  return DEMO_HEADERS['Content-Security-Policy']
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => !directive.startsWith('frame-ancestors'))
    .join('; ');
}

/** Writes the static sample site to `outputDir` and returns the list of written paths. */
export async function buildDemoSite({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  await rm(outputDir, { recursive: true, force: true });
  const written = [];
  for (const publicPath of DEMO_PUBLIC_FILES) {
    const target = join(outputDir, publicPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(PUBLIC_DIR, publicPath), target);
    written.push(publicPath);
  }

  const demoPage = await readFile(join(PUBLIC_DIR, 'demo', 'demo.html'), 'utf8');
  const policyTag = `<meta http-equiv="Content-Security-Policy" content="${metaContentSecurityPolicy()}" />`;
  const indexPage = demoPage.replace(
    '<meta charset="utf-8" />',
    `<meta charset="utf-8" />\n    ${policyTag}`,
  );
  if (indexPage === demoPage) throw new Error('demo.html no longer has the expected charset tag');
  await writeFile(join(outputDir, 'index.html'), indexPage);
  // No Jekyll processing on GitHub Pages: serve the files exactly as built.
  await writeFile(join(outputDir, '.nojekyll'), '');
  written.push('/index.html', '/.nojekyll');
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = await buildDemoSite();
  console.log(`Sample site: ${written.length} files in ${DEFAULT_OUTPUT_DIR}`);
}
