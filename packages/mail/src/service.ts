/**
 * The application mail service surface and its token.
 *
 * {@link mailToken} stays typed as the plain {@link Mailer}, so any object with
 * a `send` can still be provided under it. The plugin's own service is a
 * {@link MailService}: the same `send` plus `queue`, which hands delivery to a
 * background job instead of sending inline. The token lives in its own module
 * so the queue and the plugin can both reach it without importing each other.
 */

import { createServiceToken, type ServiceToken } from 'jsails/extensions';
import type { JobDispatchOptions } from 'jsails/jobs';
import type { MailMessage, Mailer } from './mailer.js';

/**
 * Opaque token for the application {@link Mailer}. Defined once here and shared
 * by the provider (`mailPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const mailToken: ServiceToken<Mailer> = createServiceToken<Mailer>('mail');

/**
 * Options for a queued send: the jobs runtime's dispatch options (`delay`,
 * `attempts`, `jobId`, ...), passed through verbatim and validated by the
 * runtime against its allowlist.
 */
export type MailQueueOptions = JobDispatchOptions;

/** A mailer that can also hand a message to the jobs runtime. */
export interface MailService extends Mailer {
  /**
   * Validate `message` now and dispatch the `mail.send` job that sends it from
   * a worker. Rejects with `MailError('missing_jobs')` when no jobs service is
   * registered, and with the usual validation `MailError` before anything is
   * dispatched. A `Mailable` from `defineMail` is already rendered, so it
   * queues like any message.
   */
  queue(message: MailMessage, options?: MailQueueOptions): Promise<void>;
}
