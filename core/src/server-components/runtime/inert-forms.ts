/**
 * The render-time check that every bound form a component renders is inert
 * until the client runtime takes it over.
 *
 * `submit()` spreads `method="dialog"` onto its form: a dialog-method form
 * outside a `<dialog>` submits nowhere, so a click before (or without) the
 * client script cannot navigate or leak typed values into a query string. JSX
 * spread order would let an author override that (`<form {...submit('save')}
 * method="post">`), so {@link assertInertForms} reads the rendered HTML and
 * fails the render closed when a `[data-jsails-submit]` form lacks
 * `method="dialog"` or carries an `action`.
 *
 * A submitter's `formaction` or non-dialog `formmethod` overrides whichever
 * form owns it, so the check also needs that owner to be provably unbound. The
 * render can prove it only for a submitter inside a form of the same HTML
 * (the form the HTML parser gives it: a `<form>` start tag inside an open form
 * is dropped, so its content belongs to the outer one). Every other owner lies
 * outside what the render sees: a submitter outside any form belongs to
 * whatever form encloses the component in the page (a parent component's
 * bound form, for a nested child that refreshes on its own or is kept), and
 * one with a `form` attribute belongs to the first element in the document
 * with that id. So a submitter carrying either override must sit inside an
 * unbound form of the same render and carry no `form` attribute; anything
 * else fails the render. The runtime checks a root with its nested children's
 * HTML in place, so a child rendered inside its parent's bound form is
 * checked against it.
 *
 * A bound form is one carrying `marker`: the live `data-jsails-submit`, or,
 * for a static form, the private marker its inert `submit` spreads, which
 * the static render strips once the check has run.
 *
 * It reads Preact's canonical output: every `<` outside markup is escaped and
 * every attribute value is double-quoted. A start tag it cannot read that way
 * (author raw HTML) is skipped rather than guessed at.
 */

import { SUBMIT_ATTRIBUTE } from '../protocol.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/** One parsed start tag: its lower-cased name, attributes, and end offset. */
interface StartTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly end: number;
}

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;
const ATTRIBUTE_NAME = /^[^\s"'>/=]+/;

/** True for the whitespace HTML allows between attributes. */
function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

/**
 * Parse the start tag opening at `html[at] === '<'`; `null` when it is not one
 * in canonical form (a comment, an end tag, or a single-quoted value).
 */
function readStartTag(html: string, at: number): StartTag | null {
  const nameMatch = TAG_NAME.exec(html.slice(at + 1, at + 33));
  if (nameMatch === null) {
    return null;
  }
  const attributes = new Map<string, string>();
  let index = at + 1 + nameMatch[0].length;
  for (;;) {
    while (isSpace(html[index])) {
      index += 1;
    }
    const char = html[index];
    if (char === undefined) {
      return null;
    }
    if (char === '>') {
      return { name: nameMatch[0].toLowerCase(), attributes, end: index + 1 };
    }
    if (char === '/' && html[index + 1] === '>') {
      return { name: nameMatch[0].toLowerCase(), attributes, end: index + 2 };
    }
    const attribute = ATTRIBUTE_NAME.exec(html.slice(index, index + 256));
    if (attribute === null) {
      return null;
    }
    index += attribute[0].length;
    let value = '';
    if (html[index] === '=') {
      if (html[index + 1] !== '"') {
        return null;
      }
      const close = html.indexOf('"', index + 2);
      if (close === -1) {
        return null;
      }
      value = html.slice(index + 2, close);
      index = close + 1;
    }
    attributes.set(attribute[0].toLowerCase(), value);
  }
}

/** True when a `formmethod`/`method` value is the dialog method. */
function isDialog(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === 'dialog';
}

/** True when the start tag would make the form that owns it submit somewhere. */
function overridesForm(tag: StartTag): boolean {
  if (tag.attributes.has('formaction')) {
    return true;
  }
  return tag.attributes.has('formmethod') && !isDialog(tag.attributes.get('formmethod'));
}

/** True when `html[at]` opens a `</form>` end tag. */
function isFormEnd(html: string, at: number): boolean {
  if (html.slice(at, at + 6).toLowerCase() !== '</form') {
    return false;
  }
  const next = html[at + 6];
  return next === '>' || isSpace(next);
}

/**
 * True when `html` holds a bound form that is not inert, or a submitter whose
 * override cannot be proven to land on an unbound form (see the module
 * comment). Without `overrides` (no `formaction`/`formmethod` in the HTML)
 * only form start tags can fail, so only those are read.
 */
function hasLiveForm(html: string, overrides: boolean, marker: string): boolean {
  const next = (from: number): number =>
    overrides ? html.indexOf('<', from) : html.indexOf('<form', from);
  // Whether the form the parser has open is bound; `null` outside any form.
  let open: boolean | null = null;
  let at = next(0);
  while (at !== -1) {
    if (isFormEnd(html, at)) {
      open = null;
      at = next(at + 1);
      continue;
    }
    const tag = readStartTag(html, at);
    if (tag === null) {
      at = next(at + 1);
      continue;
    }
    if (tag.name === 'form') {
      const bound = tag.attributes.has(marker);
      if (bound && (!isDialog(tag.attributes.get('method')) || tag.attributes.has('action'))) {
        return true;
      }
      // A form start tag inside an open form is dropped by the parser.
      open ??= bound;
    } else if (overridesForm(tag) && (open !== false || tag.attributes.has('form'))) {
      return true;
    }
    // Preact escapes `<` in attribute values, so the next tag starts after this one.
    at = next(tag.end);
  }
  return false;
}

const OVERRIDE_ATTRIBUTE = /formaction|formmethod/i;

/**
 * Throw a value-free `invalid_definition` error when `html` holds a bound form
 * that could submit before the client runtime takes it over, or a submitter
 * whose override could make one do so. A bound form is one carrying `marker`
 * (see the module comment).
 */
export function assertInertForms(html: string, marker: string = SUBMIT_ATTRIBUTE): void {
  const overrides = OVERRIDE_ATTRIBUTE.test(html);
  if (!overrides && !html.includes(marker)) {
    return;
  }
  if (hasLiveForm(html, overrides, marker)) {
    throw new ServerComponentRuntimeError(
      'invalid_definition',
      'a bound form must keep method="dialog" and no action, and a formaction or formmethod submitter must sit in an unbound form of its own render',
    );
  }
}
