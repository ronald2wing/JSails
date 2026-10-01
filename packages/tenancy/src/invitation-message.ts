/**
 * The invitation email, composed without storage or transport.
 *
 * {@link invitationMessage} turns the facts of an invitation into a subject, a
 * plain-text body and an HTML body that a mail delivery layer sends as is.
 * Tenant and inviter names are chosen by users, so they are treated as hostile:
 *
 * - control and format characters (line breaks, bidi overrides, zero-width
 *   characters) are removed and whitespace is collapsed, so a name cannot
 *   inject a header line or reorder the text around it;
 * - names are cut to {@link MAX_DISPLAY_NAME_LENGTH} code points;
 * - every name (tenant, inviter and role label) is set in quotation marks in
 *   the subject, the text and the HTML, and curly double quotes inside a name
 *   become straight ones, so a name cannot close its quotation and read as
 *   the message's own prose ("Your bank. Click below" stays visibly a name);
 * - link-like text in a name is defanged so mail clients do not turn it into
 *   a link that the app's trusted sender appears to vouch for: a dot followed
 *   by a letter or digit becomes U+2024 ONE DOT LEADER, `/` becomes U+2215
 *   DIVISION SLASH and `@` becomes U+FF20 FULLWIDTH COMMERCIAL AT. The name
 *   still reads the same; only the accept URL is a link;
 * - every interpolation into HTML is escaped, attributes included.
 *
 * The accept URL must be an absolute `https:` or `http:` URL without
 * credentials; it is emitted in its serialised form. The expiry is printed in
 * UTC so the message reads the same wherever it is rendered.
 */

import { TenancyError } from './tenancy-error.js';

/** The longest tenant or inviter name kept in a message, in code points. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/** The facts an invitation message is built from. */
export interface InvitationMessageInput {
  readonly tenantName: string;
  /** The inviting user's display name; omitted when unknown. */
  readonly inviterName?: string | null;
  /** The role's display label (`Admin`); omitted to leave the role out. */
  readonly roleLabel?: string | null;
  /** The absolute URL carrying the invitation token. */
  readonly acceptUrl: string | URL;
  readonly expiresAt: Date;
}

/** A composed invitation message. */
export interface InvitationMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function displayName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TenancyError('invalid_message_input');
  }
  const cleaned = value.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim();
  const points = Array.from(cleaned);
  const cut =
    points.length > MAX_DISPLAY_NAME_LENGTH
      ? `${points
          .slice(0, MAX_DISPLAY_NAME_LENGTH - 1)
          .join('')
          .trimEnd()}…`
      : cleaned;
  return cut.length === 0 ? null : defang(cut);
}

/** Break what a mail client would autolink, and the quotation marks a name sits in. */
function defang(name: string): string {
  return name
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\.(?=[\p{L}\p{N}])/gu, '\u2024')
    .replace(/\//gu, '\u2215')
    .replace(/@/gu, '\uff20');
}

/** A name in quotation marks. */
function quoted(name: string): string {
  return `\u201c${name}\u201d`;
}

function acceptHref(value: string | URL): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TenancyError('invalid_message_input', { cause: error });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TenancyError('invalid_message_input');
  }
  return url.href;
}

function utcStamp(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TenancyError('invalid_message_input');
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escape text for an HTML text node or a quoted attribute value. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Compose the subject, text and HTML of an invitation email. Throws `invalid_message_input`. */
export function invitationMessage(input: InvitationMessageInput): InvitationMessage {
  const tenant = displayName(input.tenantName);
  if (tenant === null) {
    throw new TenancyError('invalid_message_input');
  }
  const inviter = displayName(input.inviterName);
  const role = displayName(input.roleLabel);
  const href = acceptHref(input.acceptUrl);
  const expires = utcStamp(input.expiresAt);

  const subject =
    inviter === null
      ? `You have been invited to join ${quoted(tenant)}`
      : `${quoted(inviter)} invited you to join ${quoted(tenant)}`;
  const lead = (escape: (value: string) => string): string => {
    const who =
      inviter === null ? 'You have been invited' : `${escape(quoted(inviter))} invited you`;
    const as = role === null ? '' : ` as ${escape(quoted(role))}`;
    return `${who} to join ${escape(quoted(tenant))}${as}.`;
  };
  const closing = `This invitation expires on ${expires}. If you were not expecting it, you can ignore this email.`;

  const text = [lead((value) => value), '', 'Accept the invitation:', href, '', closing, ''].join(
    '\n',
  );
  const html = [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body>`,
    `<p>${lead(escapeHtml)}</p>`,
    `<p><a href="${escapeHtml(href)}">Accept the invitation</a></p>`,
    `<p>Or open this link: ${escapeHtml(href)}</p>`,
    `<p>${escapeHtml(closing)}</p>`,
    '</body></html>',
    '',
  ].join('\n');

  return Object.freeze({ subject, text, html });
}
