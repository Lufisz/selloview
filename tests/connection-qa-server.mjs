// Explicitly synthetic app configuration for real local HTTP/browser boundary tests.
// No registered app, real credential or Shopify fixture snapshot is used here.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLive } from '../server/live-server.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'metrictv-connection-http-'));
const setupOnly = process.argv.includes('--setup');
const environment = {
  SHOPIFY_STORE: 'synthetic-store.myshopify.com',
  LIVE_ALLOWED_USERS: 'owner@example.com',
  LIVE_ORIGIN: 'https://metrictv-qa.invalid',
  SHOPIFY_AUTH_MODE: 'oauth',
  PORT: '0',
};
if (!setupOnly) {
  Object.assign(environment, {
    SHOPIFY_CLIENT_ID: 'synthetic-client-id',
    SHOPIFY_CLIENT_SECRET: 'synthetic-app-secret-not-a-real-credential',
    SHOPIFY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SHOPIFY_TOKEN_STORE_PATH: path.join(directory, 'grant.enc'),
  });
}
const { server } = startLive(environment);
server.once('listening', () => {
  console.log(
    JSON.stringify({
      backend: `http://127.0.0.1:${server.address().port}`,
      origin: environment.LIVE_ORIGIN,
      state: setupOnly ? 'setup_required' : 'not_connected',
      syntheticAppConfiguration: true,
    }),
  );
});
function stop() {
  server.close(() => {
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
