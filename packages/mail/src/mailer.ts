/**
 * The mail contract shared by every transport: the message, the sender
 * surfaces, and the value-free {@link MailError}.
 *
 * A {@link Mailer} sends a single {@link MailMessage}; a {@link MailTransport}
 * is a mailer that also owns resources and can {@link MailTransport.close}.
 * The contract is deliberately small — `to`, `subject`, and an optional
 * `text`/`html` body — and does not model attachments, MIME parts, or full RFC
 * 5322 addressing. Address validation is therefore crude: an address must
 * contain exactly one `@` and carry no whitespace, control characters, or list
 * separators, and any header field (`to`/`from`/`subject`) must not contain a
 * CR/LF that could be used for header injection. Full RFC validation is out of
 * scope; a caller needing it should validate upstream or rely on the
 * transport's own checks.
 *
 * Every failure that reaches a caller is a {@link MailError}: no address,
 * subject, credential, or backend detail is ever embedded, so an error is safe
 * to log or surface verbatim.
 */

import { isRecord, JsailsError } from 'jsails/plugin-sdk';

/** Matches any ASCII/Unicode whitespace or control character (0x00-0x1F, 0x7F). */
const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f]/;

/** Matches a CR or LF, the two bytes that terminate a mail header line. */
const CR_LF = /[\r\n]/;

/** Matches a list separator or display-name bracket: one recipient per field. */
const ADDRESS_LIST_SYNTAX = /[,;<>]/;

/** Stable failure codes carried by {@link MailError}. */
export type MailErrorCode =
  | 'invalid_message'
  | 'invalid_address'
  | 'invalid_subject'
  | 'invalid_body'
  | 'closed'
  | 'missing_transport'
  | 'missing_smtp_connection'
  | 'invalid_smtp_url'
  | 'transport_failed';

/**
 * Raised for every mail failure that reaches the caller. Messages are fixed and
 * value-free: no address, subject, credential, or backend detail is embedded.
 */
export class MailError extends JsailsError {
  constructor(
    readonly code: MailErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A message to send. `to` and `subject` are required; `text` and `html` are
 * both optional (a subject-only message is sendable). `from` overrides the
 * transport's configured default sender when set.
 */
export interface MailMessage {
  /** Single recipient address (bare `user@example.com`, no display name). */
  readonly to: string;
  /** Subject line; must not contain a line break. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text?: string;
  /** HTML body. */
  readonly html?: string;
  /** Sender address; defaults to the transport's configured `from`. */
  readonly from?: string;
}

/** The send surface every mailer exposes. */
export interface Mailer {
  /** Validate and send one message. Rejects with a value-free {@link MailError}. */
  send(message: MailMessage): Promise<void>;
}

/** A mailer that owns resources; `close` is idempotent. */
export interface MailTransport extends Mailer {
  /** Release owned resources. Idempotent and safe after repeated calls. */
  close(): Promise<void>;
}

/** A message after validation: required fields are strings, optional ones stay absent. */
export interface ValidatedMail {
  readonly to: string;
  readonly from: string | undefined;
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
}

/**
 * Crudely validate one address: it must be a non-empty string containing
 * exactly one `@` and carrying no whitespace, control characters, or list
 * syntax (which also rules out a CRLF header-injection attempt and keeps a
 * transport from fanning a message out to extra recipients). Returns the
 * address unchanged.
 */
export function assertMailAddress(value: unknown, field: 'to' | 'from'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MailError('invalid_address', `mail ${field} must be a non-empty email address`);
  }
  if (!value.includes('@')) {
    throw new MailError('invalid_address', `mail ${field} must be an email address containing "@"`);
  }
  if (CONTROL_OR_WHITESPACE.test(value)) {
    throw new MailError(
      'invalid_address',
      `mail ${field} must not contain whitespace or control characters`,
    );
  }
  if (ADDRESS_LIST_SYNTAX.test(value) || value.indexOf('@') !== value.lastIndexOf('@')) {
    throw new MailError('invalid_address', `mail ${field} must be a single email address`);
  }
  return value;
}

/**
 * Validate a full message against the contract: `to`/`from` as addresses,
 * `subject` as a non-empty header without a line break, and `text`/`html` as
 * strings when present. Returns a normalized copy.
 */
export function validateMessage(message: MailMessage): ValidatedMail {
  const raw: unknown = message;
  if (!isRecord(raw)) {
    throw new MailError('invalid_message', 'mail message must be an object');
  }
  const to = assertMailAddress(message.to, 'to');
  const subject = message.subject;
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new MailError('invalid_subject', 'mail subject must be a non-empty string');
  }
  if (CR_LF.test(subject)) {
    throw new MailError('invalid_subject', 'mail subject must not contain a line break');
  }
  const from = message.from === undefined ? undefined : assertMailAddress(message.from, 'from');
  const text = message.text;
  if (text !== undefined && typeof text !== 'string') {
    throw new MailError('invalid_body', 'mail text must be a string');
  }
  const html = message.html;
  if (html !== undefined && typeof html !== 'string') {
    throw new MailError('invalid_body', 'mail html must be a string');
  }
  return { to, from, subject, text, html };
}
