/**
 * `@jsails/webhook` — inbound webhook verification for JSails.
 *
 * The default export is the plugin factory, so a `plugins.use` entry can name
 * the package directly. The named exports are the pieces a sender or a test
 * needs to reproduce a signature.
 */

export { webhookPlugin } from './plugin.js';
export type { WebhookEndpoint, WebhookPluginOptions } from './plugin.js';
export { WebhookError } from './errors.js';
export type { WebhookErrorCode } from './errors.js';
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  checkSignature,
  computeSignature,
  parseSignatureHeader,
  signedPayload,
} from './signature.js';
export type { ParsedSignature, SignatureFailure } from './signature.js';
export { claimSignature, replayKey } from './replay-guard.js';
export { verifyWebhookRequest } from './verify.js';
export type { VerifiedWebhook, VerifyWebhookOptions } from './verify.js';

export { webhookPlugin as default } from './plugin.js';
