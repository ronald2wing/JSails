/**
 * Mail templates: `defineMail(name, { subject, render, text?, preview? })`.
 *
 * A template is a named pair of a subject and a Preact component tree. Its
 * HTML part is rendered with `jsails/render-to-string`, so every interpolated
 * prop is escaped by Preact and a template cannot emit producer HTML unless it
 * opts in with `dangerouslySetInnerHTML`. The text part is the template's own
 * `text(props)` when given, otherwise it is derived from the rendered HTML
 * ({@link htmlToText}), so every message carries both alternatives.
 *
 * `message(envelope, props)` renders and returns a {@link Mailable}: an
 * ordinary {@link MailMessage} (it sends, queues, and validates like any other)
 * that also names the template it came from. Rendering is synchronous and
 * happens when the mailable is built, so a queued mailable carries its final
 * subject and bodies and the worker needs no template registry.
 *
 * `preview` holds sample props for the development preview route; a template
 * without it is still listed there but cannot be rendered.
 */

import { renderToString } from 'jsails/render-to-string';
import { htmlToText } from './html-text.js';
import { MailError, type MailMessage } from './mailer.js';

/** The element tree a template's `render` returns. */
export type MailNode = Parameters<typeof renderToString>[0];

/** A template name: letters, digits, `.`, `_`, `-`, at most 100 characters. */
const MAIL_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Matches a CR or LF, which would end the subject header early. */
const CR_LF = /[\r\n]/;

/** What {@link defineMail} accepts. */
export interface MailTemplate<P> {
  /** The subject line, fixed or computed from the props. */
  readonly subject: string | ((props: P) => string);
  /** The HTML body as a Preact element tree. */
  render(props: P): MailNode;
  /** The plain-text body; derived from the rendered HTML when omitted. */
  text?(props: P): string;
  /** Sample props for the development preview route. */
  readonly preview?: P;
}

/** A rendered template: the parts every message needs. */
export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Everything about a message except the parts the template renders. */
export type MailEnvelope = Omit<MailMessage, 'subject' | 'text' | 'html'>;

/** A rendered message that names the template it came from. */
export interface Mailable extends MailMessage {
  /** The template name. */
  readonly mail: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** A defined template. */
export interface MailDefinition<P> {
  /** The template name. */
  readonly name: string;
  /** Sample props for the development preview, when the template has them. */
  readonly preview: P | undefined;
  /** Render the subject, HTML, and text parts for `props`. */
  render(props: P): RenderedMail;
  /** Render `props` into a sendable message addressed by `envelope`. */
  message(envelope: MailEnvelope, props: P): Mailable;
}

/**
 * Define a mail template. Throws `TypeError` for a malformed definition; a
 * subject that renders empty or with a line break fails at render time with
 * `MailError('invalid_subject')`.
 */
export function defineMail<P>(name: string, template: MailTemplate<P>): MailDefinition<P> {
  if (typeof name !== 'string' || !MAIL_NAME.test(name)) {
    throw new TypeError(
      'mail name must be 1-100 letters, digits, ".", "_", or "-", starting with a letter or digit',
    );
  }
  if (template === null || typeof template !== 'object') {
    throw new TypeError('defineMail requires a template object');
  }
  if (typeof template.subject !== 'string' && typeof template.subject !== 'function') {
    throw new TypeError('mail subject must be a string or a function');
  }
  if (typeof template.render !== 'function') {
    throw new TypeError('mail render must be a function');
  }
  if (template.text !== undefined && typeof template.text !== 'function') {
    throw new TypeError('mail text must be a function');
  }
  const subjectOf = template.subject;
  const textOf = template.text;
  const renderTree = template.render;

  const render = (props: P): RenderedMail => {
    const subject = typeof subjectOf === 'function' ? subjectOf(props) : subjectOf;
    if (typeof subject !== 'string' || subject.trim() === '' || CR_LF.test(subject)) {
      throw new MailError('invalid_subject', 'mail subject must be a non-empty single line');
    }
    const body = renderToString(renderTree(props));
    // Preact cannot render a doctype, and a full document without one renders
    // in quirks mode in most mail clients.
    const html = /^<html[\s>]/i.test(body) ? `<!DOCTYPE html>${body}` : body;
    const text = textOf === undefined ? htmlToText(body) : textOf(props);
    if (typeof text !== 'string') {
      throw new MailError('invalid_body', 'mail text must be a string');
    }
    return { subject, html, text };
  };

  return Object.freeze({
    name,
    preview: template.preview,
    render,
    message(envelope: MailEnvelope, props: P): Mailable {
      if (envelope === null || typeof envelope !== 'object') {
        throw new MailError('invalid_message', 'mail envelope must be an object');
      }
      return Object.freeze({ ...envelope, ...render(props), mail: name });
    },
  });
}
