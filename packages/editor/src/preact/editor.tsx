/**
 * Browser-facing Preact component wrapping the Editor.js rich-text editor.
 *
 * `RichTextEditor` is the island `editorjs/mount.ts` hydrates: it owns the DOM
 * element, the editor handle lifecycle, prop reconciliation, and change
 * reporting. It is the concrete widget apps and admin forms hydrate, while the
 * adapter stays pure and DOM-gnostic.
 *
 * The component never trusts HTML and never renders document blocks itself: the
 * editor surface is a plain `div` that Editor.js fills after mount, and before
 * mount (server-rendered markup, or a mount failure) a fixed text fallback is
 * shown. The persisted document travels only as the serialized JSON of the
 * `RichTextDocument` prop (the hidden `input`), never as inline HTML.
 *
 * Editor.js reports a change only after a debounce and serializes it
 * asynchronously, so the hidden input can lag what the author sees. Every
 * submit of the enclosing form is therefore held until the editor has been
 * saved again, then resubmitted with that content, or refused when the content
 * has no valid rich-text form.
 *
 * This module is browser-safe: it imports only Preact, `jsails/client`, the
 * rich-text contract, and the Editor.js mount — no `node:*`, no TypeORM, no
 * blog/admin imports.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { IslandComponent, IslandMap, IslandProps } from 'jsails/client';

import {
  createEmptyRichTextDocument,
  isEditorDocument,
  validateRichTextDocument,
  type EditorDocument,
  type RichTextDocument,
} from 'jsails/rich-text';
import {
  mountRichTextEditor,
  type RichTextEditorHandle,
  type RichTextEditorSnapshot,
} from '../editorjs/mount.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RichTextEditorProps {
  /** Canonical document or an editor envelope to load and keep in sync. */
  readonly document: RichTextDocument | EditorDocument;
  /** Adapter id to wrap changes in an editor envelope; defaults from the envelope. */
  readonly editor?: string;
  /** When set, renders a hidden form input holding the serialized JSON. */
  readonly name?: string;
  /** Invoked with the current document after a user change (not the initial load). */
  readonly onChange?: (document: RichTextDocument) => void;
  /**
   * Invoked when the content after a user change has no valid rich-text form.
   * The last `onChange` document no longer matches the editor, so a host that
   * saves on `onChange` must not save it until `onChange` fires again.
   */
  readonly onInvalid?: () => void;
  /** Optional same-origin media picker endpoint for the image/gallery tools. */
  readonly mediaPickerUrl?: string;
  /** Extra CSS class merged onto the wrapper element. */
  readonly class?: string;
  /** Id applied to the wrapper element. */
  readonly id?: string;
  /** Accessible label applied to the editor surface. */
  readonly ariaLabel?: string;
}

// ---------------------------------------------------------------------------
// Island registration
// ---------------------------------------------------------------------------

/** Island name the runtime hydrates this editor under. */
export const RICH_TEXT_ISLAND = 'rich-text';

/** Shown in server-rendered markup and when the editor fails to mount. */
const FALLBACK_TEXT = 'Rich text editing requires JavaScript.';

/** Stable class names so the surface and fallback are stylable without props. */
const WRAPPER_CLASS = 'rich-text-editor';
const SURFACE_CLASS = 'rich-text-editor-surface';
const FALLBACK_CLASS = 'rich-text-editor-fallback';
const ERROR_CLASS = 'rich-text-editor-error';

/** Shown while the editor holds content that has no valid rich-text form. */
const INVALID_TEXT =
  'This content cannot be saved. Undo the last change or remove the unsupported block.';

/**
 * The hidden input's value while the content is invalid. `null` is valid JSON
 * that no rich-text schema accepts, required or optional, so a submission that
 * slips past the blocked submit (a script calling `form.submit()`) is refused
 * by the server instead of saving the last valid, now stale, document.
 */
const INVALID_VALUE = 'null';

function serializeValue(document: RichTextDocument, editor: string | undefined): string {
  return JSON.stringify(
    editor === undefined ? document : { version: 1, editor, content: document },
  );
}

// ---------------------------------------------------------------------------
// Submit guard
// ---------------------------------------------------------------------------

/** The slice of a submit event the guard reads. A real `SubmitEvent` satisfies it. */
export interface GuardedSubmitEvent {
  readonly submitter: HTMLElement | null;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

/** The slice of a form the guard drives. A real `HTMLFormElement` satisfies it. */
export interface GuardedForm {
  addEventListener(
    type: 'submit',
    listener: (event: GuardedSubmitEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: 'submit',
    listener: (event: GuardedSubmitEvent) => void,
    capture: boolean,
  ): void;
  requestSubmit(submitter?: HTMLElement | null): void;
}

export interface FormSubmitGuardOptions {
  /** Saves the editor and resolves with its newest settled content. */
  readonly flush: () => Promise<RichTextEditorSnapshot>;
  /** Applies the settled content to the form (the hidden input) before the resubmit. */
  readonly settle: (snapshot: RichTextEditorSnapshot) => void;
  /** False while the editor is not mounted, when the form already holds the authored document. */
  readonly active: () => boolean;
}

/**
 * Holds every submit of `form` until the editor has been saved, then
 * resubmits with the same submitter when the content is valid. The listener is
 * captured so it runs before the app's own submit handlers, which therefore
 * see only the resubmit. Returns the function that removes it.
 */
export function guardFormSubmit(form: GuardedForm, options: FormSubmitGuardOptions): () => void {
  let releasing = false;
  let flushing = false;
  let disposed = false;
  const onSubmit = (event: GuardedSubmitEvent): void => {
    if (releasing || !options.active()) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    // A second submit while the save runs is absorbed: the first one resubmits.
    if (flushing) {
      return;
    }
    flushing = true;
    const submitter = event.submitter;
    options
      .flush()
      .then(
        (snapshot) => {
          if (disposed) return;
          options.settle(snapshot);
          if (!snapshot.ok) return;
          // `requestSubmit` dispatches the submit event synchronously, so the
          // flag lets exactly that event through.
          releasing = true;
          try {
            form.requestSubmit(submitter);
          } finally {
            releasing = false;
          }
        },
        () => {
          if (!disposed) options.settle({ ok: false });
        },
      )
      .finally(() => {
        flushing = false;
      });
  };
  form.addEventListener('submit', onSubmit, true);
  return () => {
    disposed = true;
    form.removeEventListener('submit', onSubmit, true);
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function contentOf(document: RichTextEditorProps['document']): RichTextDocument {
  if (isEditorDocument(document)) {
    return document.content;
  }
  return document;
}

function editorIdOf(
  document: RichTextEditorProps['document'],
  explicit?: string,
): string | undefined {
  if (explicit !== undefined) return explicit;
  return isEditorDocument(document) ? document.editor : undefined;
}

export function RichTextEditor(props: RichTextEditorProps): JSX.Element {
  const initial = contentOf(props.document);
  const configuredEditor = editorIdOf(props.document, props.editor);
  // `current` is the document the hidden input serializes. It follows both the
  // editor's own changes and external prop changes, so uncontrolled (island)
  // use still submits fresh content.
  const [current, setCurrent] = useState<RichTextDocument>(initial);
  const [mounted, setMounted] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<RichTextEditorHandle | null>(null);
  // Latest `onChange` prop, so the once-created editor listener stays stable.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onInvalidRef = useRef(props.onInvalid);
  onInvalidRef.current = props.onInvalid;
  // Read by the submit guard, which outlives any one render.
  const configuredEditorRef = useRef(configuredEditor);
  configuredEditorRef.current = configuredEditor;
  // The last document applied to the editor: distinguishes an external prop
  // change from the editor reporting its own change back.
  const lastAppliedRef = useRef<RichTextDocument>(initial);
  // True while a programmatic `setDocument` is in flight, so its update
  // listener is not reported as a user change.
  const applyingRef = useRef(false);
  // Suppress Editor.js's initial render callback: the authored document is
  // already the hidden input's value, so mounting is not a user change.
  const readyRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const markInvalid = (): void => {
      setInvalid(true);
      onInvalidRef.current?.();
    };

    let handle: RichTextEditorHandle;
    try {
      handle = mountRichTextEditor({
        element: host,
        document: lastAppliedRef.current,
        ...(props.mediaPickerUrl === undefined ? {} : { mediaPickerUrl: props.mediaPickerUrl }),
        onChange: (next) => {
          if (!readyRef.current || applyingRef.current) {
            return;
          }
          lastAppliedRef.current = next;
          setInvalid(false);
          setCurrent(next);
          onChangeRef.current?.(next);
        },
        onInvalid: () => {
          if (!readyRef.current || applyingRef.current) {
            return;
          }
          markInvalid();
        },
      });
    } catch {
      // A DOM-less or otherwise unsupported environment leaves the fallback in
      // place; the hidden input still carries the authored document.
      return;
    }

    handleRef.current = handle;
    const form = host.closest('form');
    const releaseForm =
      form === null
        ? undefined
        : guardFormSubmit(form, {
            flush: () => handle.flush(),
            active: () => readyRef.current,
            settle: (snapshot) => {
              // The mount has already reported an invalid snapshot through
              // `onInvalid`; only the field state is set here.
              if (!snapshot.ok) {
                setInvalid(true);
                return;
              }
              // Written to the element directly: the resubmit follows at once,
              // before Preact renders the state below.
              if (inputRef.current !== null) {
                inputRef.current.value = serializeValue(
                  snapshot.document,
                  configuredEditorRef.current,
                );
              }
              setInvalid(false);
              setCurrent(snapshot.document);
            },
          });
    let cancelled = false;
    handle
      .ready()
      .then(() => {
        if (cancelled) {
          return;
        }
        readyRef.current = true;
        setMounted(true);
      })
      .catch(() => {
        // A DOM-less or unsupported host keeps the fallback visible; the hidden
        // input still carries the authored document.
      });

    return () => {
      cancelled = true;
      releaseForm?.();
      handle.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) {
      return;
    }
    const next = contentOf(props.document);
    if (next === lastAppliedRef.current) {
      return;
    }
    applyingRef.current = true;
    handle
      .setDocument(next)
      .then(() => {
        lastAppliedRef.current = next;
        setInvalid(false);
        setCurrent(next);
      })
      .catch(() => {
        // An invalid replacement document leaves the current content in place;
        // keep the last applied reference in sync so a later valid prop change
        // is still detected.
        lastAppliedRef.current = next;
      })
      .finally(() => {
        applyingRef.current = false;
      });
  }, [props.document]);

  const wrapperClass =
    props.class !== undefined ? `${WRAPPER_CLASS} ${props.class}` : WRAPPER_CLASS;

  return (
    <div class={wrapperClass} id={props.id}>
      <div
        ref={hostRef}
        class={SURFACE_CLASS}
        aria-label={props.ariaLabel}
        aria-invalid={invalid ? 'true' : undefined}
      />
      {!mounted && <p class={FALLBACK_CLASS}>{FALLBACK_TEXT}</p>}
      {invalid && (
        <p class={ERROR_CLASS} role="alert">
          {INVALID_TEXT}
        </p>
      )}
      {props.name !== undefined && (
        <input
          ref={inputRef}
          type="hidden"
          name={props.name}
          value={invalid ? INVALID_VALUE : serializeValue(current, configuredEditor)}
        />
      )}
    </div>
  );
}

/**
 * Island adapter for `${RICH_TEXT_ISLAND}`: decodes the untyped `IslandProps`
 * the runtime hands a hydrated island into the typed {@link RichTextEditor}
 * props. `onChange` is deliberately not part of the island contract — island
 * props travel as bounded JSON, so the editor reports changes only through the
 * hidden `input`'s serialized value on submit.
 */
export const RichTextIsland: IslandComponent<IslandProps> = (props) => {
  const raw = props.document;
  let document: RichTextDocument = createEmptyRichTextDocument();
  let editor: string | undefined;
  if (isEditorDocument(raw)) {
    document = raw.content;
    editor = raw.editor;
  } else {
    const validated = validateRichTextDocument(raw);
    if (validated.ok) document = validated.value;
  }
  return (
    <RichTextEditor
      document={document}
      editor={typeof props.editor === 'string' ? props.editor : editor}
      name={typeof props.name === 'string' ? props.name : undefined}
      mediaPickerUrl={typeof props.mediaPickerUrl === 'string' ? props.mediaPickerUrl : undefined}
      class={typeof props.class === 'string' ? props.class : undefined}
      id={typeof props.id === 'string' ? props.id : undefined}
      ariaLabel={typeof props.ariaLabel === 'string' ? props.ariaLabel : undefined}
    />
  );
};

/** Declarative island map for `startClient({ islands })`. */
export const richTextIsland: IslandMap = Object.freeze({
  [RICH_TEXT_ISLAND]: RichTextIsland,
});
