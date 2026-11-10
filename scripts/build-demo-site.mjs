// Builds the sample dashboard as plain static files for any static host (GitHub Pages, Cloudflare
// Pages). It copies only the files the sample server may serve, so nothing private can slip in.
// Static hosts cannot send response headers, so the page carries its Content-Security-Policy itself.
// When the site's origin is known (SAMPLE_SITE_ORIGIN) it also writes the share tags, a sitemap and
// robots.txt, which all need absolute URLs.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_PUBLIC_FILES } from '../server/http/public-files.mjs';
import { DEMO_HEADERS } from '../server/demo.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, 'dist', 'demo-site');
// The share image is a screenshot of the sample board: fictional data only.
const SOCIAL_CARD_SOURCE = join(PROJECT_ROOT, 'docs', 'screenshots', 'dashboard.png');
const SOCIAL_CARD_PATH = '/social-card.png';

// A <meta> policy cannot use frame-ancestors; browsers ignore it there.
function metaContentSecurityPolicy() {
  return DEMO_HEADERS['Content-Security-Policy']
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => !directive.startsWith('frame-ancestors'))
    .join('; ');
}

function normalizeSiteOrigin(siteOrigin) {
  let url;
  try {
    url = new URL(siteOrigin);
  } catch {
    throw new Error(`The site origin is not a valid URL: ${siteOrigin}`);
  }
  const isPlainHttpsOrigin =
    url.protocol === 'https:' && url.origin === siteOrigin.replace(/\/$/, '');
  if (!isPlainHttpsOrigin) {
    throw new Error(
      `The site origin must be a plain https origin such as https://example.com, got: ${siteOrigin}`,
    );
  }
  return url.origin;
}

// The title and description are read from the page, so they are written once.
function shareTags(page, origin) {
  const title = page.match(/<title>([^<]*)<\/title>/)?.[1];
  const description = page.match(/name="description"\s+content="([^"]*)"/)?.[1];
  if (!title || !description) throw new Error('demo.html no longer has a title and a description');
  return [
    `<link rel="canonical" href="${origin}/" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${origin}/" />`,
    `<meta property="og:image" content="${origin}${SOCIAL_CARD_PATH}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ');
}

async function writeSearchFiles(outputDir, origin) {
  await copyFile(SOCIAL_CARD_SOURCE, join(outputDir, SOCIAL_CARD_PATH));
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${origin}/</loc></url>`,
    '</urlset>',
    '',
  ].join('\n');
  await writeFile(join(outputDir, 'sitemap.xml'), sitemap);
  const robots = ['User-agent: *', 'Allow: /', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
  await writeFile(join(outputDir, 'robots.txt'), robots);
}

/** Writes the static sample site to `outputDir` and returns the list of written paths. */
export async function buildDemoSite({
  outputDir = DEFAULT_OUTPUT_DIR,
  siteOrigin = process.env.SAMPLE_SITE_ORIGIN,
} = {}) {
  const origin = siteOrigin ? normalizeSiteOrigin(siteOrigin) : null;
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
  const headTags = origin ? `${policyTag}\n    ${shareTags(demoPage, origin)}` : policyTag;
  const indexPage = demoPage.replace(
    '<meta charset="utf-8" />',
    `<meta charset="utf-8" />\n    ${headTags}`,
  );
  if (indexPage === demoPage) throw new Error('demo.html no longer has the expected charset tag');
  await writeFile(join(outputDir, 'index.html'), indexPage);
  // No Jekyll processing on GitHub Pages: serve the files exactly as built.
  await writeFile(join(outputDir, '.nojekyll'), '');
  written.push('/index.html', '/.nojekyll');

  if (origin) {
    await writeSearchFiles(outputDir, origin);
    written.push(SOCIAL_CARD_PATH, '/sitemap.xml', '/robots.txt');
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = await buildDemoSite();
  console.log(`Sample site: ${written.length} files in ${DEFAULT_OUTPUT_DIR}`);
}
