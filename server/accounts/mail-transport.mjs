// Server-only delivery of one-time sign-in codes.
//
// A transport is injected into the auth layer. The only production transport is Resend over
// HTTPS, enabled solely by operator configuration. Without it, delivery fails closed: nothing is
// pretended, logged or returned to the browser.
import { CodedError } from '../errors.mjs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SENDER_LENGTH = 200;
const SENDER_PATTERN = /^(?:[^<>\r\n"]{1,100} )?<?[^\s<>@"]{1,64}@[^\s<>@"]{1,190}>?$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

/** Stable, secret-free failure reason for logs and the sign-in page. */
export class DeliveryError extends CodedError {}

/** Transport used when the operator configured no provider. */
export const unconfiguredTransport = Object.freeze({
  configured: false,
  async sendSignInCode() {
    throw new DeliveryError('delivery_not_configured');
  },
});

/**
 * Reads METRICTV_RESEND_API_KEY and METRICTV_MAIL_FROM. Both or neither: a half-configured provider is a
 * startup error rather than a quiet fallback.
 */
export function loadMailConfig(env = process.env) {
  const apiKey = env.METRICTV_RESEND_API_KEY ?? '';
  const sender = env.METRICTV_MAIL_FROM ?? '';
  if (apiKey === '' && sender === '') return null;
  if (!API_KEY_PATTERN.test(apiKey)) throw new Error('METRICTV_RESEND_API_KEY is not a valid key');
  if (sender.length > MAX_SENDER_LENGTH || !SENDER_PATTERN.test(sender)) {
    throw new Error('METRICTV_MAIL_FROM must be an address or "Name <address>"');
  }
  return { apiKey, sender };
}

function buildMessage({ sender, recipient, code, validMinutes }) {
  return {
    from: sender,
    to: [recipient],
    subject: 'Your MetricTV sign-in code',
    text:
      `Your MetricTV sign-in code is ${code}.\n\n` +
      `It expires in ${validMinutes} minutes and works once. ` +
      'If you did not ask for it, ignore this message.',
  };
}

/** Bounded Resend adapter. `fetchImpl` is injectable so tests never reach the provider. */
export function createResendTransport({ apiKey, sender, fetchImpl = fetch, validMinutes = 5 }) {
  return Object.freeze({
    configured: true,
    async sendSignInCode({ recipient, code }) {
      let response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildMessage({ sender, recipient, code, validMinutes })),
        });
      } catch {
        throw new DeliveryError('delivery_unreachable');
      }
      await response.body?.cancel();
      if (!response.ok) throw new DeliveryError('delivery_rejected');
    },
  });
}
