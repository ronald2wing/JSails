/**
 * The `@jsails/mail` package: a transport-agnostic mail seam.
 *
 * It exports the {@link Mailer} contract, three transports
 * ({@link InMemoryMailTransport} for in-memory capture, {@link SmtpMailTransport}
 * for lazy SMTP over nodemailer, and {@link CallbackMailTransport} for an
 * injected callback), and the {@link mailPlugin} that exposes an application
 * mailer under a typed service token with lazy, fail-closed transport
 * resolution.
 *
 * Importing this barrel pulls in nodemailer's type declarations only at the
 * type level (`transports.ts` loads nodemailer lazily at first send), so the
 * package is safe to import in a browser-free server context.
 */

export {
  MailError,
  type Mailer,
  type MailErrorCode,
  type MailMessage,
  type MailTransport,
  type ValidatedMail,
} from './mailer.js';

export {
  CallbackMailTransport,
  InMemoryMailTransport,
  SmtpMailTransport,
  type MailCallback,
  type MemoryMailTransport,
  type SmtpConnectionConfig,
  type SmtpMailOptions,
  type SmtpTransportDependencies,
  type SmtpTransportOptions,
  type SmtpTransporter,
} from './transports.js';

export { Mail, mailPlugin, mailToken, type MailPluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { mailPlugin as default } from './plugin.js';
