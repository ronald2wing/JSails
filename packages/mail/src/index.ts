/**
 * The `@jsails/mail` package: a transport-agnostic mail seam.
 *
 * It exports the {@link Mailer} contract, three transports
 * ({@link InMemoryMailTransport} for in-memory capture, {@link SmtpMailTransport}
 * for lazy SMTP over nodemailer, and {@link CallbackMailTransport} for an
 * injected callback), Preact mail templates ({@link defineMail}), queued
 * delivery through the jobs runtime ({@link queueMail}, {@link mailSendJob}),
 * and the {@link mailPlugin} that exposes an application mailer under a typed
 * service token with lazy, fail-closed transport resolution and a
 * development-only preview.
 *
 * Importing this barrel pulls in nodemailer's type declarations only at the
 * type level (`transports.ts` loads nodemailer lazily at first send), and
 * `jsails/jobs` only when a message is first queued, so the package is safe to
 * import in a browser-free server context.
 */

export {
  MailError,
  MAX_MAIL_RECIPIENTS,
  type MailAddress,
  type MailAddressList,
  type MailAttachment,
  type Mailer,
  type MailErrorCode,
  type MailMessage,
  type MailRecipient,
  type MailTransport,
  type ValidatedMail,
  type ValidatedMailAttachment,
} from './mailer.js';

export {
  CallbackMailTransport,
  InMemoryMailTransport,
  SMTP_DEFAULTS,
  SmtpMailTransport,
  type MailCallback,
  type MemoryMailTransport,
  type SmtpAddress,
  type SmtpConnectionConfig,
  type SmtpMailOptions,
  type SmtpTransportDependencies,
  type SmtpTransportOptions,
  type SmtpTransporter,
} from './transports.js';

export {
  defineMail,
  type Mailable,
  type MailDefinition,
  type MailEnvelope,
  type MailNode,
  type MailTemplate,
  type RenderedMail,
} from './define-mail.js';

export { htmlToText } from './html-text.js';

export {
  createMailSendJob,
  decodeQueuedMail,
  encodeQueuedMail,
  MAIL_SEND_JOB,
  mailSendJob,
  MAX_QUEUED_MAIL_BYTES,
  queuedMailSchema,
  queueMail,
  queueMailThrough,
  type MailSendJobOptions,
  type QueuedMail,
} from './queue.js';

export { MAIL_PREVIEW_PATH, type MailPreview } from './preview.js';

export { mailToken, type MailQueueOptions, type MailService } from './service.js';

export { Mail, mailPlugin, mailTransportToken, type MailPluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { mailPlugin as default } from './plugin.js';
