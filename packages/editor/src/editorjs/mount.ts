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
 * Every Editor.js change starts an asynchronous `save`, and saves can overlap
 * and settle out of order. Each save is numbered and only the newest one is
 * reported, so a host never receives an older document after a newer one;
 * {@link RichTextEditorHandle.flush} waits for the newest save, which is what a
 * form submit must do so it never sends content older than what is on screen.
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
import { JsailsError, detach, escalate } from 'jsails/support';

import { editorJsToRichText, richTextToEditorJs, type EditorJsOutputData } from './conversion.js';
import { isMediaPickerUrl } from './picker.js';
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

/** Machine-readable reason for an {@link EditorMountError}. */
export type EditorMountErrorCode =
  'no_dom' | 'invalid_document' | 'unsupported_block' | 'destroyed';

/** A value-free mount failure. Messages never echo block content or the element. */
export class EditorMountError extends JsailsError {
  constructor(
    readonly code: EditorMountErrorCode,
    message: string,
  ) {
    super(message);
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
  readonly element: EditorElement;
  /** The initial rich-text document to load. Validated on mount. */
  readonly document: unknown;
  /**
   * Invoked with the current document after a user change; never for the
   * initial load. Only the newest save is reported, so documents arrive in
   * edit order.
   */
  readonly onChange?: (document: RichTextDocument) => void;
  /**
   * Invoked instead of `onChange` when the editor's content after a user
   * change has no valid rich-text form, or its save failed. The last reported
   * document is then stale, so a host must not persist it until `onChange`
   * fires again.
   */
  readonly onInvalid?: () => void;
  /**
   * Optional same-origin media picker endpoint for the image/gallery tools.
   * Validated with {@link isMediaPickerUrl}; an invalid value is ignored
   * (the tools fall back to their manual id inputs) rather than failing mount.
   */
  readonly mediaPickerUrl?: string;
  /**
   * Optional Editor.js instance factory for tests. Defaults to the lazy
   * Editor.js-backed core; a test injects a DOM-free double so the full handle
   * lifecycle is exercisable under `node:test` without jsdom. The double calls
   * `onEditorChange` where Editor.js would call its `onChange`.
   */
  readonly _createEditor?: (
    element: EditorElement,
    data: EditorJsOutputData,
    onEditorChange: () => void,
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

/** The settled content of the editor: its rich-text document, or `ok: false` when it has none. */
export type RichTextEditorSnapshot =
  { readonly ok: true; readonly document: RichTextDocument } | { readonly ok: false };

export interface RichTextEditorHandle {
  /** Construct the editor and wait for Editor.js readiness. */
  ready(): Promise<void>;
  /** Resolve the current document from the live editor. */
  getDocument(): Promise<RichTextDocument>;
  /**
   * Save the editor now and resolve with the newest settled content, after
   * reporting it through `onChange` or `onInvalid`. A change made while this
   * save runs is waited for too, so the result is never older than the editor.
   */
  flush(): Promise<RichTextEditorSnapshot>;
  /** Replace the editor content with a validated document. */
  setDocument(document: unknown): Promise<void>;
  /** Move focus into the editor. */
  focus(): void;
  /** Tear down the editor and its listeners. Idempotent. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// List tool
// ---------------------------------------------------------------------------

/**
 * The list tool class. Its declarations are CommonJS-shaped, so the compiler
 * types the default import as the module object, while the ESM build the
 * browser loads hands over the class itself.
 */
const EditorJsList = ListTool as unknown as typeof ListTool.default;

type ListToolbox = typeof EditorJsList.toolbox;
type ListToolboxEntry = Extract<ListToolbox, readonly unknown[]>[number];
type ListMenuItem = ReturnType<InstanceType<typeof EditorJsList>['renderSettings']>[number];

function isChecklistEntry(entry: ListToolboxEntry): boolean {
  return (entry.data as { style?: unknown } | undefined)?.style === 'checklist';
}

/** The icon `@editorjs/list` draws for its checklist style, in the toolbox and the tunes alike. */
const CHECKLIST_ICON = (
  Array.isArray(EditorJsList.toolbox) ? EditorJsList.toolbox : [EditorJsList.toolbox]
).find(isChecklistEntry)?.icon;

/**
 * A persisted list item holds text only, with no children, so nesting is
 * switched off: a nested list would be authored, then saved flat without a
 * word. Conversion still flattens nested items that arrive by paste.
 */
const LIST_TOOL_CONFIG: Readonly<{ maxLevel: number }> = Object.freeze({ maxLevel: 1 });

/**
 * `@editorjs/list` without its checklist style. A persisted list is ordered or
 * unordered only, so a checklist could be written but never saved; the tool
 * has no option to turn the style off, so this hides its toolbox entry and its
 * block tune. The tune is recognized by its icon, the one stable marker the
 * library gives it (its label is translated).
 */
export class RichTextListTool extends EditorJsList {
  static override get toolbox(): ListToolbox {
    const toolbox = super.toolbox;
    return Array.isArray(toolbox) ? toolbox.filter((entry) => !isChecklistEntry(entry)) : toolbox;
  }

  override renderSettings(): ListMenuItem[] {
    return super
      .renderSettings()
      .filter(
        (item) => CHECKLIST_ICON === undefined || !('icon' in item) || item.icon !== CHECKLIST_ICON,
      );
  }
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

/** The Editor.js `tools` map the mount configures, with the picker wired when given. */
export function richTextEditorTools(
  pickerConfig: MediaPickerToolConfig | undefined,
): Readonly<Record<string, unknown>> {
  return {
    header: HeaderTool,
    list: { class: RichTextListTool, config: LIST_TOOL_CONFIG },
    quote: QuoteTool,
    code: CodeTool,
    delimiter: DelimiterTool,
    image: pickerConfig === undefined ? ImageTool : { class: ImageTool, config: pickerConfig },
    gallery:
      pickerConfig === undefined ? GalleryTool : { class: GalleryTool, config: pickerConfig },
    embed: EmbedTool,
    callout: CalloutTool,
    cta: CtaTool,
  };
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
    throw new EditorMountError('no_dom', 'mount requires a DOM element');
  }

  // Validate and convert the initial document before touching the DOM, so a
  // bad document fails closed without a half-constructed editor.
  const initial = richTextToEditorJs(options.document);
  if (!initial.ok) {
    throw new EditorMountError(initial.error.code, initial.error.message);
  }

  let destroyed = false;
  const assertAlive = (): void => {
    if (destroyed) {
      throw new EditorMountError('destroyed', 'the editor has already been destroyed');
    }
  };

  const toRichTextDocument = (payload: unknown): RichTextDocument => {
    const built = editorJsToRichText(payload);
    if (!built.ok) {
      throw new EditorMountError(built.error.code, built.error.message);
    }
    return built.document;
  };

  // The instance as soon as it is constructed (before readiness), so a change
  // reported during startup can still be saved.
  let constructed: EditorJsInstance | undefined;
  let saveSequence = 0;
  let latestSave: Promise<RichTextEditorSnapshot> | undefined;

  const saveAndReport = (instance: EditorJsInstance): Promise<RichTextEditorSnapshot> => {
    const sequence = ++saveSequence;
    const run = (async (): Promise<RichTextEditorSnapshot> => {
      let snapshot: RichTextEditorSnapshot;
      try {
        const built = editorJsToRichText(await instance.save());
        snapshot = built.ok ? { ok: true, document: built.document } : { ok: false };
      } catch {
        // A failed save leaves the content unknown. Reporting it as invalid
        // keeps the host from treating the previous document as current.
        snapshot = { ok: false };
      }
      // An older save settling after a newer one started is not reported:
      // the newer one describes the editor.
      if (!destroyed && sequence === saveSequence) {
        if (snapshot.ok) {
          options.onChange?.(snapshot.document);
        } else {
          options.onInvalid?.();
        }
      }
      return snapshot;
    })();
    latestSave = run;
    return run;
  };

  const onEditorChange = (): void => {
    if (destroyed || constructed === undefined) return;
    detach(saveAndReport(constructed), escalate);
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
      options.mediaPickerUrl !== undefined && isMediaPickerUrl(options.mediaPickerUrl)
        ? options.mediaPickerUrl
        : undefined;
    const pickerConfig: MediaPickerToolConfig | undefined =
      pickerUrl === undefined ? undefined : { mediaPickerUrl: pickerUrl };
    return new EditorJS({
      holder: options.element,
      data: initial.output,
      tools: richTextEditorTools(pickerConfig),
      onChange: onEditorChange,
    });
  };

  const factory: () => EditorJsInstance | Promise<EditorJsInstance> =
    options._createEditor !== undefined
      ? () => options._createEditor!(options.element, initial.output, onEditorChange)
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
          constructed = instance;
          if (destroyed) {
            instance.destroy();
            const error = new EditorMountError(
              'destroyed',
              'the editor has already been destroyed',
            );
            throw error;
          }
          await instance.isReady;
          editor = instance;
          return instance;
        })
        .catch((error: unknown) => {
          editorPromise = undefined;
          if (error instanceof EditorMountError) {
            throw error;
          }
          throw new EditorMountError('no_dom', 'mount failed to construct the editor');
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
    async flush(): Promise<RichTextEditorSnapshot> {
      const instance = await ensureEditor();
      let pending = saveAndReport(instance);
      for (;;) {
        const snapshot = await pending;
        assertAlive();
        if (latestSave === undefined || latestSave === pending) {
          return snapshot;
        }
        pending = latestSave;
      }
    },
    async setDocument(next: unknown): Promise<void> {
      assertAlive();
      const converted = richTextToEditorJs(next);
      if (!converted.ok) {
        throw new EditorMountError(converted.error.code, converted.error.message);
      }
      const instance = await ensureEditor();
      await instance.render(converted.output);
    },
    focus(): void {
      detach(
        ensureEditor().then((instance) => instance.focus(false)),
        escalate,
      );
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      editor?.destroy();
    },
  };
}
