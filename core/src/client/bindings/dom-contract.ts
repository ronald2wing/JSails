/**
 * Structural DOM contract for the component binding layer.
 *
 * The binding modules declare the slice of the DOM they touch instead of
 * depending on the DOM lib, so they stay Node-importable and testable against
 * minimal fakes; a real `HTMLElement`/`document` satisfies every member.
 */

import type { ComponentUploadFile } from '../component-upload.js';
import type { JsailsDocument, JsailsElement, JsailsEvent } from '../islands.js';
import { JsailsError } from '../../errors/jsails-error.js';

/** The slice of a DOM element the binding layer touches. */
export interface ComponentElement extends JsailsElement {
  readonly tagName: string;
  readonly parentElement: ComponentElement | null;
  /** Current value of a form control (`input`/`select`/`textarea`). */
  value?: string;
  /** Checked state of a checkbox/radio. */
  checked?: boolean;
  /** Control type (`text`, `checkbox`, `number`, ...). */
  type?: string;
  /** Whether a `<select>` allows multiple selections. */
  multiple?: boolean;
  /** Selected options of a `<select>`. */
  readonly selectedOptions?: ArrayLike<{ readonly value: string }>;
  /** Selected files of a file input (`input.files`). */
  files?: ArrayLike<ComponentUploadFile>;
  querySelector(selector: string): ComponentElement | null;
  querySelectorAll(selector: string): ArrayLike<ComponentElement>;
  closest(selector: string): ComponentElement | null;
  /** Insert `element` relative to this element (error message placement). */
  insertAdjacentElement(position: string, element: ComponentElement): void;
  /** Remove this element from the document. */
  remove(): void;
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
  /** Visibility toggle (mirrors `HTMLElement.hidden`). */
  hidden?: boolean;
  /** Move focus to this control (optional; absent on minimal test fakes). */
  focus?(): void;
}

/** The slice of `document` the binding layer touches. */
export interface ComponentDocument extends JsailsDocument {
  querySelector(selector: string): ComponentElement | null;
  getElementById(id: string): ComponentElement | null;
  createElement(tagName: string): ComponentElement;
}

/** Stable machine codes carried by {@link ComponentBindingError}. */
export type ComponentBindingErrorCode = 'invalid_binding';

/** Raised for binding-layer misconfiguration. Messages are value-free. */
export class ComponentBindingError extends JsailsError {
  readonly code: ComponentBindingErrorCode = 'invalid_binding';
}
