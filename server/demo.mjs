// Static demo server: serves only the public directory. No APIs, credentials, analytics or database.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyServerLimits,
  createSecurityHeaders,
  findPublicFile,
  isReadMethod,
  parseRequestPath,
  SERVER_OPTIONS,
} from './http/static-files.mjs';
import { DEMO_PAGES, DEMO_PUBLIC_FILES, publicPathFor } from './http/public-files.mjs';

const DEFAULT_PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const DEMO_HEADERS = createSecurityHeaders();

export function createDemoHandler({ publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  function sendText(response, status, text, extraHeaders = {}) {
    response.writeHead(status, { ...DEMO_HEADERS, ...extraHeaders });
    response.end(text);
  }

  return async (request, response) => {
    if (!isReadMethod(request.method)) {
      return sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const parsed = parseRequestPath(request.url);
    if (parsed.rejection === 'bad_request') return sendText(response, 400, 'Bad request');
    if (parsed.rejection) return sendText(response, 404, 'Not found');

    const requestedPath = publicPathFor(DEMO_PAGES, parsed.pathname);
    const file = await findPublicFile(publicDir, requestedPath, DEMO_PUBLIC_FILES);
    if (!file) return sendText(response, 404, 'Not found');
    try {
      const body = await readFile(file.filePath);
      response.writeHead(200, {
        ...DEMO_HEADERS,
        'Content-Type': file.contentType,
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      sendText(response, 404, 'Not found');
    }
  };
}

export function createDemoServer(options) {
  return applyServerLimits(createServer(SERVER_OPTIONS, createDemoHandler(options)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4317);
  createDemoServer().listen(port, host, () =>
    console.log(`MetricTV prototype: http://${host}:${port}`),
  );
}
