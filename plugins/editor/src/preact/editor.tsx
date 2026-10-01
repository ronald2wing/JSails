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
 * This module is browser-safe: it imports only Preact, `jsails/client`, the
 * rich-text contract, and the Editor.js mount — no `node:*`, no TypeORM, no
 * blog/admin imports.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { IslandComponent, IslandMap, IslandProps } from 'jsails/client';

import type { RichTextDocument } from 'jsails/rich-text';
import {
  createEmptyRichTextDocument,
  isEditorDocument,
  validateRichTextDocument,
} from 'jsails/rich-text';
import { mountRichTextEditor, type RichTextEditorHandle } from '../editorjs/mount.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RichTextEditorProps {
  /** Canonical document or an editor envelope to load and keep in sync. */
  document: RichTextDocument | import('jsails/rich-text').EditorDocument;
  /** Adapter id to wrap changes in an editor envelope; defaults from the envelope. */
  editor?: string;
  /** When set, renders a hidden form input holding the serialized JSON. */
  name?: string;
  /** Invoked with the current document after a user change (not the initial load). */
  onChange?: (document: RichTextDocument) => void;
  /** Optional same-origin media picker endpoint for the image/gallery tools. */
  mediaPickerUrl?: string;
  /** Extra CSS class merged onto the wrapper element. */
  class?: string;
  /** Id applied to the wrapper element. */
  id?: string;
  /** Accessible label applied to the editor surface. */
  ariaLabel?: string;
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

export function RichTextEditor(props: RichTextEditorProps) {
  const initial = contentOf(props.document);
  const configuredEditor = editorIdOf(props.document, props.editor);
  // `current` is the document the hidden input serializes. It follows both the
  // editor's own changes and external prop changes, so uncontrolled (island)
  // use still submits fresh content.
  const [current, setCurrent] = useState<RichTextDocument>(initial);
  const [mounted, setMounted] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<RichTextEditorHandle | null>(null);
  // Latest `onChange` prop, so the once-created editor listener stays stable.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
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
          setCurrent(next);
          onChangeRef.current?.(next);
        },
      });
    } catch {
      // A DOM-less or otherwise unsupported environment leaves the fallback in
      // place; the hidden input still carries the authored document.
      return;
    }

    handleRef.current = handle;
    let cancelled = false;
    void handle
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
    void handle
      .setDocument(next)
      .then(() => {
        lastAppliedRef.current = next;
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
      <div ref={hostRef} class={SURFACE_CLASS} aria-label={props.ariaLabel} />
      {!mounted && <p class={FALLBACK_CLASS}>{FALLBACK_TEXT}</p>}
      {props.name !== undefined && (
        <input
          type="hidden"
          name={props.name}
          value={JSON.stringify(
            configuredEditor === undefined
              ? current
              : { version: 1, editor: configuredEditor, content: current },
          )}
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
export const richTextIsland: IslandMap = {
  [RICH_TEXT_ISLAND]: RichTextIsland,
};
