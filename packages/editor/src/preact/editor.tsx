/**
 * The Preact face of the rich-text editor: `RichTextEditor`, a component
 * around the ProseMirror editor, and `RichTextIsland`, the form-field island
 * that hydrates the field markup (`../field/contract.ts`).
 *
 * The island implements the field's three states:
 *
 * 1. Not started (before hydration, while the editor loads, or when it
 *    failed to load or mount): the server's source input stays as it is, so
 *    a submit sends the original value back unchanged.
 * 2. Editing: once the editor is mounted the island removes the source input
 *    and, on the form's `formdata` event, sets the field to
 *    `JSON.stringify(handle.getDocument())`. The submitted value is the
 *    editor state at that moment by construction: nothing is mirrored,
 *    debounced or held.
 * 3. Unreadable (the source value is not a document `parseRichText` reads):
 *    a read-only panel lists the issues, with no editor and no field, so a
 *    submit omits the field and the server keeps the stored value. Replacing
 *    it is an explicit, confirmed "discard and start empty".
 *
 * Hydration keeps the server's markup as it is until the runtime has read
 * the source: the island's first render is that input, bare, followed by
 * the same wrapper element the server renders, whose content is set through
 * `dangerouslySetInnerHTML` (fixed text, never data). Preact neither diffs
 * attributes nor replaces such content while hydrating, so the wrapper keeps
 * whatever the server put there, the fallback text or the unreadable panel,
 * and its `data-state`, instead of flashing a loading line over the panel.
 * The wrapper carries `data-state` (`loading`, `editing`, `unreadable`,
 * `failed`) for styling and tests; the island's own render sets it once the
 * runtime has read the source.
 *
 * Everything past this shell (`parseRichText`, ProseMirror and the editor
 * UI) is in `./editor-runtime.ts`, loaded with `import()` when the first
 * field hydrates or the first `RichTextEditor` mounts, so the client entry a
 * page loads up front carries only the shell. A bundle that serves its
 * entry under a cache-busting query must keep the entry out of every chunk's
 * imports (the starter's Vite config moves the entry's modules into a
 * content-hashed chunk); otherwise the runtime chunk would import a second
 * copy of the client.
 */

import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { IslandComponent, IslandMap, IslandProps } from 'jsails/client';
import type { RichTextDocument } from 'jsails/rich-text';

import {
  FIELD_WRAPPER_CLASS,
  RICH_TEXT_ISLAND,
  RICH_TEXT_SOURCE_ATTRIBUTE,
  UNREADABLE_KEPT_TEXT,
  UNREADABLE_TITLE,
  describeIssues,
} from '../field/contract.js';
import type { RichTextEditorHandle } from '../prosemirror/ui/rich-text-editor.js';
import type * as EditorRuntime from './editor-runtime.js';

/**
 * The runtime chunk, loaded once and shared by every field; a failed load is
 * not cached, so the next field to hydrate tries again.
 */
let runtime: Promise<typeof EditorRuntime> | undefined;

function loadEditorRuntime(): Promise<typeof EditorRuntime> {
  runtime ??= import('./editor-runtime.js').catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}

/**
 * The wrapper's content while the runtime loads, written only by a render
 * that is not hydrating; hydration keeps the server's content instead.
 */
const LOADING_MARKUP = {
  __html: '<p class="rich-text-editor-fallback" role="status">Starting the editor…</p>',
};
const FAILED_TEXT =
  'The editor could not start. Saving the form keeps this field’s content unchanged.';

// ---------------------------------------------------------------------------
// RichTextEditor
// ---------------------------------------------------------------------------

/**
 * Props of {@link RichTextEditor}.
 *
 * @public
 */
export interface RichTextEditorProps {
  /**
   * The document to edit; it must pass `parseRichText`. A later, different
   * document replaces the content (and the undo history), unless it is the
   * one the editor last reported through `onChange`.
   */
  readonly document: RichTextDocument;
  /** Called with the current document after every change to it. */
  readonly onChange?: (document: RichTextDocument) => void;
  /** Called once the editor is mounted, with its handle. */
  readonly onMount?: (handle: RichTextEditorHandle) => void;
  /** Called when the editor could not be loaded or mounted. */
  readonly onMountError?: () => void;
  /** The media library endpoint the image and gallery blocks offer. */
  readonly mediaPickerUrl?: string;
  /** The accessible name of the editable surface. */
  readonly label?: string;
  /** The id of the editable surface. */
  readonly id?: string;
  /** Extra class names on the element the editor is built in. */
  readonly class?: string;
}

/**
 * The rich-text editor as a Preact component. It renders an empty element
 * and, once mounted, loads the editor and builds it there; the element is
 * not rendered on the server with any content. Until the editor is built
 * there is no handle, and a `document` prop given meanwhile is the one the
 * editor starts with.
 *
 * @public
 */
export function RichTextEditor(props: RichTextEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<RichTextEditorHandle | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // The document the editor holds as far as the props know: the one it was
  // given or the one it last reported. A prop equal to it is no replacement.
  const held = useRef<RichTextDocument>(props.document);
  // The document prop the replacement effect last compared. Preact may run a
  // render's effect late (as the next render starts), so the effect judges
  // its own prop against the previous prop, never against the editor alone.
  const seenProp = useRef<RichTextDocument>(props.document);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return undefined;
    }
    let unmounted = false;
    let handle: RichTextEditorHandle | undefined;
    const mount = ({ mountRichTextEditor }: typeof EditorRuntime): void => {
      if (unmounted) {
        return;
      }
      const current = latest.current;
      held.current = current.document;
      try {
        handle = mountRichTextEditor({
          element: host,
          document: current.document,
          ...(current.label === undefined ? {} : { label: current.label }),
          ...(current.id === undefined ? {} : { id: current.id }),
          ...(current.mediaPickerUrl === undefined
            ? {}
            : { mediaPickerUrl: current.mediaPickerUrl }),
          onChange: (document) => {
            held.current = document;
            latest.current.onChange?.(document);
          },
        });
      } catch {
        // A refused document or a browser that cannot run the editor: the
        // caller keeps its fallback (for the island, the source input stays
        // in the form).
        current.onMountError?.();
        return;
      }
      handleRef.current = handle;
      current.onMount?.(handle);
    };
    loadEditorRuntime().then(mount, () => {
      // The chunk did not load (offline, a deploy replaced it): the same
      // fallback as a failed mount.
      if (!unmounted) {
        latest.current.onMountError?.();
      }
    });
    return () => {
      unmounted = true;
      handle?.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (props.document === seenProp.current) {
      return;
    }
    seenProp.current = props.document;
    const handle = handleRef.current;
    if (handle === null || props.document === held.current) {
      return;
    }
    held.current = props.document;
    try {
      handle.setDocument(props.document);
    } catch {
      // A document parseRichText refuses leaves the content as it is.
      return;
    }
  }, [props.document]);

  return (
    <div
      ref={hostRef}
      class={
        props.class === undefined ? 'rich-text-editor-host' : `rich-text-editor-host ${props.class}`
      }
    />
  );
}

// ---------------------------------------------------------------------------
// RichTextIsland
// ---------------------------------------------------------------------------

type FieldState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'unreadable';
      readonly lines: readonly string[];
      readonly more: number;
      readonly confirming: boolean;
      /** The document "discard and start empty" starts from. */
      readonly empty: RichTextDocument;
    }
  | { readonly kind: 'editing'; readonly document: RichTextDocument; readonly mounted: boolean };

function stringProp(props: IslandProps, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' ? value : undefined;
}

let panelCount = 0;

/**
 * The rich-text form-field island (`rich-text`): hydrates the field markup
 * the server renders (`RichTextField`, or the admin's `richText` input) and
 * keeps the three-state form contract described in this module's header.
 *
 * @public
 */
export const RichTextIsland: IslandComponent<IslandProps> = (props) => {
  const name = stringProp(props, 'name');
  const label = stringProp(props, 'label');
  const id = stringProp(props, 'id');
  const mediaPickerUrl = stringProp(props, 'mediaPickerUrl');

  const sourceRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const handleRef = useRef<RichTextEditorHandle | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const panelId = useRef('');
  if (panelId.current === '') {
    panelCount += 1;
    panelId.current = `rich-text-unreadable-${String(panelCount)}`;
  }
  const [state, setState] = useState<FieldState>({ kind: 'loading' });

  useLayoutEffect(() => {
    const source = sourceRef.current;
    if (source === null) {
      return undefined;
    }
    formRef.current = source.form;
    // The bytes the server wrote, read before anything can change them.
    const raw = source.value;
    let unmounted = false;
    loadEditorRuntime().then(
      ({ readFieldSource, createEmptyRichTextDocument }) => {
        if (unmounted) {
          return;
        }
        const read = readFieldSource(raw);
        setState(
          read.ok
            ? { kind: 'editing', document: read.document, mounted: false }
            : {
                kind: 'unreadable',
                ...describeIssues(read.issues),
                confirming: false,
                empty: createEmptyRichTextDocument(),
              },
        );
      },
      () => {
        // The runtime chunk did not load: the source input stays (state 1).
        if (!unmounted) {
          setState({ kind: 'failed' });
        }
      },
    );
    return () => {
      unmounted = true;
      detachRef.current?.();
      detachRef.current = null;
    };
  }, []);

  /** Mounted: the form now takes the field from the editor, then the source input goes. */
  const onMount = (handle: RichTextEditorHandle): void => {
    handleRef.current = handle;
    const form = formRef.current;
    if (form !== null && name !== undefined) {
      const onFormData = (event: Event): void => {
        const current = handleRef.current;
        if (current !== null) {
          (event as FormDataEvent).formData.set(name, JSON.stringify(current.getDocument()));
        }
      };
      form.addEventListener('formdata', onFormData);
      detachRef.current = () => {
        form.removeEventListener('formdata', onFormData);
      };
    }
    setState((previous) =>
      previous.kind === 'editing' ? { ...previous, mounted: true } : previous,
    );
  };

  const onMountError = (): void => {
    setState({ kind: 'failed' });
  };

  const sourceAttributes = { [RICH_TEXT_SOURCE_ATTRIBUTE]: '' };
  const source = <input key="source" type="hidden" ref={sourceRef} {...sourceAttributes} />;

  switch (state.kind) {
    case 'loading':
      return (
        <>
          {source}
          <div
            key="field"
            class={FIELD_WRAPPER_CLASS}
            data-state="loading"
            dangerouslySetInnerHTML={LOADING_MARKUP}
          />
        </>
      );
    case 'failed':
      return (
        <>
          {source}
          <div key="field" class={FIELD_WRAPPER_CLASS} data-state="failed">
            <p class="rich-text-editor-fallback">{FAILED_TEXT}</p>
          </div>
        </>
      );
    case 'unreadable':
      return (
        <div key="field" class={FIELD_WRAPPER_CLASS} data-state="unreadable">
          <div class="rich-text-editor-unreadable" role="group" aria-labelledby={panelId.current}>
            <p id={panelId.current} class="rich-text-editor-unreadable-title">
              {UNREADABLE_TITLE}
            </p>
            <ul>
              {state.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {state.more > 0 && <p>{`And ${String(state.more)} more.`}</p>}
            <p>{UNREADABLE_KEPT_TEXT}</p>
            {state.confirming ? (
              <p>
                Discarding replaces the stored content with an empty document when the form is
                saved.{' '}
                <button
                  type="button"
                  onClick={() => {
                    setState({ kind: 'editing', document: state.empty, mounted: false });
                  }}
                >
                  Discard and start empty
                </button>{' '}
                <button
                  type="button"
                  onClick={() => {
                    setState({ ...state, confirming: false });
                  }}
                >
                  Keep the stored content
                </button>
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setState({ ...state, confirming: true });
                }}
              >
                Discard the stored content…
              </button>
            )}
          </div>
        </div>
      );
    case 'editing':
      return (
        <>
          {!state.mounted && source}
          <div
            key="field"
            class={FIELD_WRAPPER_CLASS}
            data-state={state.mounted ? 'editing' : 'loading'}
          >
            <RichTextEditor
              document={state.document}
              onMount={onMount}
              onMountError={onMountError}
              {...(label === undefined ? {} : { label })}
              {...(id === undefined ? {} : { id })}
              {...(mediaPickerUrl === undefined ? {} : { mediaPickerUrl })}
            />
          </div>
        </>
      );
  }
};

/**
 * The declarative island map for `startClient({ islands })`.
 *
 * @public
 */
export const richTextIsland: IslandMap = Object.freeze({
  [RICH_TEXT_ISLAND]: RichTextIsland,
});
