// Starts the MetricTV app server from the environment (see .env.example). Loopback only: a tunnel
// or proxy in front is the operator's separate, explicitly approved step.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './accounts/auth.mjs';
import { openInitializedDatabase } from './accounts/accounts.mjs';
import { createRegistrationPolicy, loadRegistrationConfig } from './accounts/registration.mjs';
import {
  createResendTransport,
  loadMailConfig,
  unconfiguredTransport,
} from './accounts/mail-transport.mjs';
import { createBetaServer } from './app.mjs';
import { loadBetaConfig } from './config.mjs';
import { loadBetaShopifyConfig } from './shopify/config.mjs';
import { createBetaShopifyService } from './shopify/connection-service.mjs';

function startFromEnvironment() {
  const config = loadBetaConfig();
  const mailConfig = loadMailConfig();
  const mailTransport = mailConfig ? createResendTransport(mailConfig) : unconfiguredTransport;
  const shopifyConfig = loadBetaShopifyConfig(process.env);
  const registrationConfig = loadRegistrationConfig(process.env);
  const database = openInitializedDatabase(config.databasePath);
  const registration = createRegistrationPolicy({ database, config: registrationConfig });
  const auth = createAuth({
    database,
    secret: config.secret,
    origin: config.origin,
    mailTransport,
    registration,
  });
  const shopify = createBetaShopifyService({
    database,
    config: shopifyConfig,
    origin: config.origin,
  });
  const server = createBetaServer({ auth, database, config, mailTransport, registration, shopify });
  server.listen(config.port, config.host, () => {
    const delivery = mailTransport.configured
      ? 'configured'
      : 'NOT configured (sign-in codes cannot be sent)';
    console.log(`MetricTV beta on http://${config.host}:${config.port} for ${config.origin}`);
    console.log(`Email delivery: ${delivery}`);
    const signUp = registration.enabled
      ? `OPEN, capped at ${registrationConfig.maxAccounts} accounts`
      : 'closed (invite-only)';
    console.log(`Self-service registration: ${signUp}`);
    const connection = shopify.configured ? 'configured' : 'NOT configured (setup required)';
    console.log(`Shopify store connection: ${connection}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startFromEnvironment();
  } catch (error) {
    console.error(`MetricTV beta cannot start: ${error.message}`);
    process.exit(1);
  }
}
