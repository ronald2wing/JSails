/**
 * The mail contract shared by every transport: the message, the sender
 * surfaces, and the value-free {@link MailError}.
 *
 * A {@link Mailer} sends a single {@link MailMessage}; a {@link MailTransport}
 * is a mailer that also owns resources and can {@link MailTransport.close}.
 * A message has one or more recipients (`to`, plus optional `cc`/`bcc`), an
 * optional `replyTo`, a subject, a `text`/`html` body, and optional in-memory
 * attachments. An address is either a bare string or a structured
 * `{ name, address }`; the display name is never parsed out of a string, so a
 * caller cannot smuggle extra recipients through one. Validation is crude by
 * design: an address must contain exactly one `@` and carry no whitespace,
 * control characters, or list separators; a display name, attachment filename,
 * and the subject must not contain a CR/LF that could inject a header. The
 * validated form formats each address list as an RFC 5322 header value
 * (`"Name" <user@example.com>, other@example.com`) for transports that log or
 * forward the message as text. A transport that builds the MIME message itself
 * (SMTP) takes the structured entries from {@link validateMessageAddresses}
 * instead, so the formatted string is never parsed back into recipients. Full
 * RFC validation is out of scope.
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

/** Matches a list separator or display-name bracket: one recipient per address. */
const ADDRESS_LIST_SYNTAX = /[,;<>]/;

/** Matches control characters, including CR/LF (but not ordinary spaces). */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The most recipients one message may carry across `to`, `cc`, and `bcc`. */
export const MAX_MAIL_RECIPIENTS = 100;

/** The longest display name accepted. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** A `type/subtype` content type with no parameters or header syntax. */
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Stable failure codes carried by {@link MailError}. */
export type MailErrorCode =
  | 'invalid_message'
  | 'invalid_address'
  | 'invalid_subject'
  | 'invalid_body'
  | 'invalid_attachment'
  | 'closed'
  | 'missing_transport'
  | 'missing_smtp_connection'
  | 'invalid_smtp_url'
  | 'transport_failed'
  | 'missing_jobs'
  | 'too_large';

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

/** An address: bare `user@example.com`, or a display name plus a bare address. */
export type MailAddress = string | { readonly name: string; readonly address: string };

/** One or several addresses. */
export type MailAddressList = MailAddress | readonly MailAddress[];

/** An in-memory attachment. */
export interface MailAttachment {
  /** The name the recipient sees; no path separators or line breaks. */
  readonly filename: string;
  /** The bytes, or text encoded as UTF-8. */
  readonly content: Uint8Array | string;
  /** A bare `type/subtype`; the transport guesses from the filename when absent. */
  readonly contentType?: string;
}

/**
 * A message to send. `to` and `subject` are required; `text` and `html` are
 * both optional (a subject-only message is sendable). `from` overrides the
 * transport's configured default sender when set.
 */
export interface MailMessage {
  /** One recipient or several. */
  readonly to: MailAddressList;
  /** Carbon-copy recipients. */
  readonly cc?: MailAddressList;
  /** Blind carbon-copy recipients: delivered to, never listed in a header. */
  readonly bcc?: MailAddressList;
  /** Where replies go, when not the sender. */
  readonly replyTo?: MailAddressList;
  /** Subject line; must not contain a line break. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text?: string;
  /** HTML body. */
  readonly html?: string;
  /** Sender; defaults to the transport's configured `from`. */
  readonly from?: MailAddress;
  /** In-memory attachments. */
  readonly attachments?: readonly MailAttachment[];
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

/**
 * A message after validation. Address fields are formatted RFC 5322 header
 * values; `to`, `from`, `subject`, `text`, and `html` are always present
 * (optional ones as `undefined`), while `cc`, `bcc`, `replyTo`, and
 * `attachments` appear only when the message set them.
 */
export interface ValidatedMail {
  readonly to: string;
  readonly from: string | undefined;
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly cc?: string;
  readonly bcc?: string;
  readonly replyTo?: string;
  readonly attachments?: readonly ValidatedMailAttachment[];
}

/** An attachment after validation: the content is always bytes. */
export interface ValidatedMailAttachment {
  readonly filename: string;
  readonly content: Uint8Array;
  readonly contentType: string | undefined;
}

/** One validated address; `name` is `''` for a bare address. */
export interface MailRecipient {
  readonly name: string;
  readonly address: string;
}

/**
 * A message's addresses after validation, as structured entries. Lists are
 * empty when the message did not set them; `from` is `undefined` when the
 * message relies on the transport's default sender.
 */
export interface ValidatedMailAddresses {
  readonly from: MailRecipient | undefined;
  readonly to: readonly MailRecipient[];
  readonly cc: readonly MailRecipient[];
  readonly bcc: readonly MailRecipient[];
  readonly replyTo: readonly MailRecipient[];
}

/** Address fields as they appear in error messages. */
type AddressField = 'to' | 'from' | 'cc' | 'bcc' | 'replyTo';

/**
 * Crudely validate one bare address: it must be a non-empty string containing
 * exactly one `@` and carrying no whitespace, control characters, or list
 * syntax (which also rules out a CRLF header-injection attempt and keeps a
 * transport from fanning a message out to extra recipients). Returns the
 * address unchanged.
 */
export function assertMailAddress(value: unknown, field: AddressField): string {
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
 * Validate one address (bare or structured) into a {@link MailRecipient}. A
 * string is always a bare address; a display name is only ever taken from the
 * structured form, so it is never parsed out of text.
 */
export function parseMailAddress(value: unknown, field: AddressField): MailRecipient {
  if (typeof value === 'string') {
    return { name: '', address: assertMailAddress(value, field) };
  }
  if (!isRecord(value)) {
    throw new MailError('invalid_address', `mail ${field} must be an address or { name, address }`);
  }
  const address = assertMailAddress(value.address, field);
  const name = value.name;
  if (typeof name !== 'string' || name.length > MAX_DISPLAY_NAME_LENGTH || CONTROL.test(name)) {
    throw new MailError(
      'invalid_address',
      `mail ${field} display name must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters without control characters`,
    );
  }
  return { name: name.trim() === '' ? '' : name, address };
}

/**
 * Validate one address (bare or structured) and format it for a header. A
 * display name is always quoted, with `"` and `\` escaped, so no character in
 * it can end the name early and start another address.
 */
export function formatMailAddress(value: unknown, field: AddressField): string {
  return formatRecipient(parseMailAddress(value, field));
}

function formatRecipient(recipient: MailRecipient): string {
  if (recipient.name === '') {
    return recipient.address;
  }
  return `"${recipient.name.replace(/["\\]/g, (match) => `\\${match}`)}" <${recipient.address}>`;
}

/** Validate an address list into structured entries (empty when absent). */
function parseAddressList(value: unknown, field: AddressField, required: boolean): MailRecipient[] {
  if (value === undefined && !required) {
    return [];
  }
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value];
  if (entries.length === 0) {
    if (required) {
      throw new MailError('invalid_address', `mail ${field} must name at least one recipient`);
    }
    return [];
  }
  return entries.map((entry) => parseMailAddress(entry, field));
}

/**
 * Validate every address field of a message, including the recipient cap,
 * and return them as structured entries.
 */
export function validateMessageAddresses(message: MailMessage): ValidatedMailAddresses {
  const raw: unknown = message;
  if (!isRecord(raw)) {
    throw new MailError('invalid_message', 'mail message must be an object');
  }
  const to = parseAddressList(raw.to, 'to', true);
  const cc = parseAddressList(raw.cc, 'cc', false);
  const bcc = parseAddressList(raw.bcc, 'bcc', false);
  const replyTo = parseAddressList(raw.replyTo, 'replyTo', false);
  if (to.length + cc.length + bcc.length > MAX_MAIL_RECIPIENTS) {
    throw new MailError(
      'invalid_address',
      `mail must have at most ${MAX_MAIL_RECIPIENTS} recipients across to, cc, and bcc`,
    );
  }
  const from = raw.from === undefined ? undefined : parseMailAddress(raw.from, 'from');
  return { from, to, cc, bcc, replyTo };
}

function joinRecipients(list: readonly MailRecipient[]): string {
  return list.map(formatRecipient).join(', ');
}

/** Validate the attachments, normalizing text content to bytes. */
function validateAttachments(value: unknown): ValidatedMailAttachment[] {
  if (!Array.isArray(value)) {
    throw new MailError('invalid_attachment', 'mail attachments must be an array');
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new MailError('invalid_attachment', 'mail attachment must be an object');
    }
    const { filename, content, contentType } = entry;
    if (
      typeof filename !== 'string' ||
      filename.trim() === '' ||
      CONTROL.test(filename) ||
      /[\\/]/.test(filename)
    ) {
      throw new MailError(
        'invalid_attachment',
        'mail attachment filename must be a plain name without separators or control characters',
      );
    }
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      throw new MailError(
        'invalid_attachment',
        'mail attachment content must be bytes or a string',
      );
    }
    if (
      contentType !== undefined &&
      (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType))
    ) {
      throw new MailError('invalid_attachment', 'mail attachment contentType must be type/subtype');
    }
    return {
      filename,
      content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
      contentType,
    };
  });
}

/**
 * Validate a full message against the contract: every address field, the
 * recipient cap, `subject` as a non-empty header without a line break,
 * `text`/`html` as strings when present, and the attachments. Returns a
 * normalized copy.
 */
export function validateMessage(message: MailMessage): ValidatedMail {
  const raw: unknown = message;
  if (!isRecord(raw)) {
    throw new MailError('invalid_message', 'mail message must be an object');
  }
  const { from, to, cc, bcc, replyTo } = validateMessageAddresses(message);
  const subject = message.subject;
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new MailError('invalid_subject', 'mail subject must be a non-empty string');
  }
  if (CR_LF.test(subject)) {
    throw new MailError('invalid_subject', 'mail subject must not contain a line break');
  }
  const text = message.text;
  if (text !== undefined && typeof text !== 'string') {
    throw new MailError('invalid_body', 'mail text must be a string');
  }
  const html = message.html;
  if (html !== undefined && typeof html !== 'string') {
    throw new MailError('invalid_body', 'mail html must be a string');
  }
  const attachments =
    raw.attachments === undefined ? undefined : validateAttachments(raw.attachments);
  return {
    to: joinRecipients(to),
    from: from === undefined ? undefined : formatRecipient(from),
    subject,
    text,
    html,
    ...(cc.length === 0 ? {} : { cc: joinRecipients(cc) }),
    ...(bcc.length === 0 ? {} : { bcc: joinRecipients(bcc) }),
    ...(replyTo.length === 0 ? {} : { replyTo: joinRecipients(replyTo) }),
    ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
  };
}
