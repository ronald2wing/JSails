/**
 * DOM mount adapter for the rich-text editor.
 *
 * `mountRichTextEditor` is the seam between an Editor.js instance and a live DOM
 * element: it validates the element and the incoming document, instantiates
 * Editor.js wired to the official header/list/quote/code/delimiter tools (the
 * `paragraph` block is Editor.js's built-in default) plus the custom
 * image/gallery/embed/callout/cta tools from `tools.ts`, loads the initial
 * content through {@link richTextToEditorJs}, and reports changes back through
 * `onChange` via {@link editorJsToRichText}. It owns no Preact and no
 * sanitization — it persists a rich-text document, never trusts client HTML.
 *
 * `@editorjs/editorjs` is loaded lazily (dynamic `import`) because its UMD build
 * touches `document`/`window`/`Element` at module load and would therefore crash
 * under `node:test`. The test seam {@link MountRichTextEditorOptions._createEditor}
 * supplies a DOM-free double, so the handle lifecycle is exercisable without a
 * DOM and without loading Editor.js at all.
 *
 * The element contract is structural (there is no DOM lib in the project): a
 * real `HTMLElement` satisfies {@link EditorElement}, and the guard rejects
 * anything that does not. A DOM-less or inert host surfaces as `no_dom`.
 */

import HeaderTool from '@editorjs/header';
import ListTool from '@editorjs/list';
import QuoteTool from '@editorjs/quote';
import CodeTool from '@editorjs/code';
import DelimiterTool from '@editorjs/delimiter';

import type { RichTextDocument } from 'jsails/rich-text';

import { editorJsToRichText, richTextToEditorJs, type EditorJsOutputData } from './adapter.js';
import { validateMediaPickerUrl } from './picker.js';
import {
  CalloutTool,
  CtaTool,
  EmbedTool,
  GalleryTool,
  ImageTool,
  type MediaPickerToolConfig,
} from './tools.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for an {@link EditorError}. */
export type EditorErrorCode = 'no_dom' | 'invalid_document' | 'unsupported_block' | 'destroyed';

/** A value-free mount failure. Messages never echo block content or the element. */
export class EditorError extends Error {
  readonly code: EditorErrorCode;

  constructor(code: EditorErrorCode, message: string) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Element / options / handle contracts
// ---------------------------------------------------------------------------

/** The slice of a DOM element this adapter touches. A real `HTMLElement` satisfies it. */
export interface EditorElement {
  readonly nodeType: number;
  readonly tagName: string;
  classList: { add(...names: string[]): void };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
}

export interface MountRichTextEditorOptions {
  /** The host element (a real `HTMLElement` in the browser). Required. */
  element: EditorElement;
  /** The initial rich-text document to load. Validated on mount. */
  document: unknown;
  /** Invoked with the current document after a user change; never for the initial load. */
  onChange?: (document: RichTextDocument) => void;
  /**
   * Optional same-origin media picker endpoint for the image/gallery tools.
   * Validated with {@link validateMediaPickerUrl}; an invalid value is ignored
   * (the tools fall back to their manual id inputs) rather than failing mount.
   */
  mediaPickerUrl?: string;
  /**
   * Optional Editor.js instance factory for tests. Defaults to the lazy
   * Editor.js-backed core; a test injects a DOM-free double so the full handle
   * lifecycle is exercisable under `node:test` without jsdom.
   */
  _createEditor?: (
    element: EditorElement,
    data: EditorJsOutputData,
    onSave: (payload: unknown) => void,
  ) => EditorJsInstance | Promise<EditorJsInstance>;
}

/** The narrow slice of Editor.js the mount drives (also the test double's contract). */
export interface EditorJsInstance {
  readonly isReady: Promise<void>;
  save(): Promise<unknown>;
  render(data: EditorJsOutputData): Promise<void>;
  focus(atEnd?: boolean): boolean;
  destroy(): void;
}

export interface RichTextEditorHandle {
  /** Construct the editor and wait for Editor.js readiness. */
  ready(): Promise<void>;
  /** Resolve the current document from the live editor. */
  getDocument(): Promise<RichTextDocument>;
  /** Replace the editor content with a validated document. */
  setDocument(document: unknown): Promise<void>;
  /** Move focus into the editor. */
  focus(): void;
  /** Tear down the editor and its listeners. Idempotent. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Structural guard
// ---------------------------------------------------------------------------

function isEditorElement(value: unknown): value is EditorElement {
  if (value == null || typeof value !== 'object') return false;
  const element = value as Partial<EditorElement>;
  return (
    typeof element.nodeType === 'number' &&
    typeof element.tagName === 'string' &&
    typeof element.setAttribute === 'function' &&
    typeof element.focus === 'function' &&
    typeof element.classList === 'object' &&
    element.classList !== null &&
    typeof element.classList.add === 'function'
  );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountRichTextEditor(options: MountRichTextEditorOptions): RichTextEditorHandle {
  if (!isEditorElement(options.element)) {
    throw new EditorError('no_dom', 'mount requires a DOM element');
  }

  // Validate and convert the initial document before touching the DOM, so a
  // bad document fails closed without a half-constructed editor.
  const initial = richTextToEditorJs(options.document);
  if (!initial.ok) {
    throw new EditorError(initial.error.code, initial.error.message);
  }

  let destroyed = false;
  const assertAlive = (): void => {
    if (destroyed) {
      throw new EditorError('destroyed', 'the editor has already been destroyed');
    }
  };

  const toRichTextDocument = (payload: unknown): RichTextDocument => {
    const built = editorJsToRichText(payload);
    if (!built.ok) {
      throw new EditorError(built.error.code, built.error.message);
    }
    return built.document;
  };

  const emit = (payload: unknown): void => {
    if (destroyed) return;
    try {
      options.onChange?.(toRichTextDocument(payload));
    } catch {
      // A conversion failure during a live edit is a framework-internal edge;
      // swallow it so a transient state never crashes the listener.
    }
  };

  const defaultEditorFactory = async (): Promise<EditorJsInstance> => {
    // Loaded lazily: the UMD build requires a DOM at module load, so this
    // module must stay Node-importable for the adapter tests (which inject a
    // double through `_createEditor` and never reach this path).
    const { default: EditorJS } = (await import('@editorjs/editorjs')) as unknown as {
      default: new (config: Record<string, unknown>) => EditorJsInstance;
    };
    // Wire the picker only when a valid endpoint is configured; an absent or
    // invalid URL leaves the tools as the bare classes (manual id inputs).
    const pickerUrl =
      options.mediaPickerUrl !== undefined &&
      validateMediaPickerUrl(options.mediaPickerUrl) === undefined
        ? options.mediaPickerUrl
        : undefined;
    const pickerConfig: MediaPickerToolConfig | undefined =
      pickerUrl === undefined ? undefined : { mediaPickerUrl: pickerUrl };
    let instance: EditorJsInstance;
    const editor = (instance = new EditorJS({
      holder: options.element,
      data: initial.output,
      tools: {
        header: HeaderTool,
        list: ListTool,
        quote: QuoteTool,
        code: CodeTool,
        delimiter: DelimiterTool,
        image: pickerConfig === undefined ? ImageTool : { class: ImageTool, config: pickerConfig },
        gallery:
          pickerConfig === undefined ? GalleryTool : { class: GalleryTool, config: pickerConfig },
        embed: EmbedTool,
        callout: CalloutTool,
        cta: CtaTool,
      },
      onChange: () => {
        // The callback fires before `save` resolves; each change re-serializes
        // the whole output and routes it through the adapter.
        void instance.save().then(emit);
      },
    }));
    return editor;
  };

  const factory: () => EditorJsInstance | Promise<EditorJsInstance> =
    options._createEditor !== undefined
      ? () => options._createEditor!(options.element, initial.output, emit)
      : defaultEditorFactory;

  // The editor instance resolves on first use; construction failure (a DOM-less
  // host) surfaces as `no_dom` rather than a raw TypeError.
  let editorPromise: Promise<EditorJsInstance> | undefined;
  let editor: EditorJsInstance | undefined;
  const ensureEditor = async (): Promise<EditorJsInstance> => {
    assertAlive();
    if (editor !== undefined) {
      return editor;
    }
    if (editorPromise === undefined) {
      editorPromise = Promise.resolve()
        .then(() => factory())
        .then(async (instance) => {
          if (destroyed) {
            instance.destroy();
            const error = new EditorError('destroyed', 'the editor has already been destroyed');
            throw error;
          }
          await instance.isReady;
          editor = instance;
          return instance;
        })
        .catch((error: unknown) => {
          editorPromise = undefined;
          if (error instanceof EditorError) {
            throw error;
          }
          throw new EditorError('no_dom', 'mount failed to construct the editor');
        });
    }
    return editorPromise;
  };

  return {
    async ready(): Promise<void> {
      await ensureEditor();
    },
    async getDocument(): Promise<RichTextDocument> {
      const instance = await ensureEditor();
      return toRichTextDocument(await instance.save());
    },
    async setDocument(next: unknown): Promise<void> {
      assertAlive();
      const converted = richTextToEditorJs(next);
      if (!converted.ok) {
        throw new EditorError(converted.error.code, converted.error.message);
      }
      const instance = await ensureEditor();
      await instance.render(converted.output);
    },
    focus(): void {
      void ensureEditor().then((instance) => instance.focus(false));
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      editor?.destroy();
    },
  };
}
