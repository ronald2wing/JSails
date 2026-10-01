/**
 * Custom Editor.js block tools for the structured rich-text block kinds that
 * have no first-party Editor.js equivalent: image, gallery, embed, callout, and
 * CTA. Paragraph, header, list, quote, code, and delimiter map onto the official
 * tools and are provided by the mount; these five carry their persisted fields
 * as tool data and render a minimal but usable editable form.
 *
 * There is no DOM lib in the project (`tsconfig` `lib` is `["ES2023"]`), so each
 * tool builds its UI through a structural {@link DomNode} type: a real
 * `HTMLElement`/`document` satisfies it at runtime while the module stays
 * Node-importable and DOM-gnostic. `save()` reads the persisted fields back from
 * the rendered inputs (nothing is trusted from the DOM beyond the fields the
 * form exposes), so a block round-trips to its Editor.js tool data.
 */

import type { BlockToolConstructorOptions } from '@editorjs/editorjs';

import { mapMediaAssetsToPickerItems, pickerItemLabel, validateMediaPickerUrl } from './picker.js';

// ---------------------------------------------------------------------------
// Structural DOM surface
// ---------------------------------------------------------------------------

/** The element slice tools build/read; a real `HTMLElement` satisfies it. */
interface DomNode {
  textContent: string;
  value: string;
  appendChild(child: DomNode): void;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): { value: string } | null;
  addEventListener(type: string, listener: () => void): void;
}

/** A document-like factory; a real `document` satisfies it in the browser. */
interface DomFactory {
  createElement(tagName: string): DomNode;
}

/** Resolve the ambient `document`, or a structural shim when no DOM exists. */
function domFactory(): DomFactory {
  const documentLike = (globalThis as unknown as { document?: DomFactory }).document;
  if (documentLike !== undefined) {
    return documentLike;
  }
  return {
    createElement: () => ({
      textContent: '',
      value: '',
      appendChild() {},
      setAttribute() {},
      querySelector: () => null,
      addEventListener() {},
    }),
  };
}

/** A browser `fetch`-like function; a real `globalThis.fetch` satisfies it. */
interface FetchLike {
  (url: string, init: { credentials: string }): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/** Resolve the ambient `fetch`, or `undefined` when no network surface exists. */
function resolveFetch(): FetchLike | undefined {
  return (globalThis as unknown as { fetch?: FetchLike }).fetch;
}

/** The input-holder a `save` receives; a real block `HTMLElement` satisfies it. */
type SaveBlock = { querySelector(selector: string): { value: string } | null };

/** Build a labelled text input carrying a stable `data-field` query key. */
function field(factory: DomFactory, name: string, value: string, placeholder: string): DomNode {
  const wrapper = factory.createElement('div');
  const label = factory.createElement('label');
  label.textContent = placeholder;
  const input = factory.createElement('input');
  input.setAttribute('type', 'text');
  input.setAttribute('data-field', name);
  input.value = value;
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
}

/** Read the value of a `data-field` input from a rendered block. */
function readField(block: SaveBlock, name: string): string {
  return block.querySelector(`[data-field="${name}"]`)?.value ?? '';
}

// ---------------------------------------------------------------------------
// Media picker
// ---------------------------------------------------------------------------

/** Tool config shared by the image and gallery tools. */
export interface MediaPickerToolConfig {
  /** A validated picker endpoint; absent when no picker is configured. */
  mediaPickerUrl?: string;
}

/** Resolve a validated picker URL from tool config, or `undefined`. */
function resolveMediaPickerUrl(config: MediaPickerToolConfig | undefined): string | undefined {
  if (config === undefined || config.mediaPickerUrl === undefined) {
    return undefined;
  }
  // The mount already validated before wiring config; this second guard keeps
  // a hand-constructed tool safe too. An invalid URL degrades to a manual input.
  return validateMediaPickerUrl(config.mediaPickerUrl) === undefined
    ? config.mediaPickerUrl
    : undefined;
}

/** A stable, value-free message for picker fetch/parse failures. */
const PICKER_ERROR_TEXT = 'Media list could not be loaded.';

/**
 * A "Choose media" control.
 *
 * `buildPicker` renders a button plus a (initially empty) list/status host. The
 * button fetches {@link url} with same-origin credentials, projects the JSON
 * payload through {@link mapMediaAssetsToPickerItems}, and lets `onSelect` run
 * per item (selecting one id for an image, toggling many for a gallery). Every
 * label is applied through `textContent`; failure is reported as a value-free
 * status line and never throws.
 *
 * Returns the two nodes the caller appends to its block wrapper: the trigger
 * button (built here) and the host into which items/status are rendered.
 */
function buildPicker(
  factory: DomFactory,
  url: string,
  onSelect: (item: { id: string }) => void,
): { button: DomNode; host: DomNode } {
  const button = factory.createElement('button');
  button.setAttribute('type', 'button');
  button.textContent = 'Choose media';

  const host = factory.createElement('div');

  button.addEventListener('click', () => {
    const fetcher = resolveFetch();
    if (fetcher === undefined) {
      host.textContent = PICKER_ERROR_TEXT;
      return;
    }
    void fetcher(url, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) {
          throw new Error('picker request failed');
        }
        return response.json();
      })
      .then((json) => {
        const items = mapMediaAssetsToPickerItems(json);
        if (items.length === 0) {
          host.textContent = 'No media found.';
          return;
        }
        // Clear any previous list or status; textContent reset also drops old item nodes.
        host.textContent = '';
        for (const item of items) {
          host.appendChild(buildPickerItem(factory, item.id, pickerItemLabel(item), onSelect));
        }
      })
      .catch(() => {
        // Network failure, a non-2xx status, or malformed JSON all surface here
        // as the same value-free message; the fetched payload is never echoed.
        host.textContent = PICKER_ERROR_TEXT;
      });
  });

  return { button, host };
}

/** One selectable asset row (a plain button whose label is text content only). */
function buildPickerItem(
  factory: DomFactory,
  id: string,
  label: string,
  onSelect: (item: { id: string }) => void,
): DomNode {
  const itemButton = factory.createElement('button');
  itemButton.setAttribute('type', 'button');
  itemButton.textContent = label;
  itemButton.addEventListener('click', () => onSelect({ id }));
  return itemButton;
}

// ---------------------------------------------------------------------------
// Toolbox descriptors
// ---------------------------------------------------------------------------

/** A minimal toolbox descriptor; the icon is a short text marker. */
interface ToolboxDescriptor {
  icon: string;
  title: string;
}

/** Data shapes each tool persists (mirror the persisted block fields). */
export interface ImageData {
  mediaId: string;
  alt?: string;
  caption?: string;
}

export interface GalleryData {
  mediaIds: string[];
  alt?: string;
}

export interface EmbedData {
  url: string;
}

export interface CalloutData {
  tone: 'info' | 'success' | 'warning' | 'danger';
  text: string;
}

export interface CtaData {
  label: string;
  href: string;
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export class ImageTool {
  private readonly _data: ImageData;
  private readonly _mediaPickerUrl: string | undefined;

  static get toolbox(): ToolboxDescriptor {
    return { icon: 'IMG', title: 'Image' };
  }

  constructor({ data, config }: BlockToolConstructorOptions<ImageData, MediaPickerToolConfig>) {
    this._data = {
      mediaId: typeof data.mediaId === 'string' ? data.mediaId : '',
      ...(typeof data.alt === 'string' && data.alt !== '' ? { alt: data.alt } : {}),
      ...(typeof data.caption === 'string' && data.caption !== '' ? { caption: data.caption } : {}),
    };
    this._mediaPickerUrl = resolveMediaPickerUrl(config);
  }

  render(): DomNode {
    const factory = domFactory();
    const wrapper = factory.createElement('div');
    const mediaId = field(factory, 'mediaId', this._data.mediaId, 'Media id');
    wrapper.appendChild(mediaId);
    if (this._mediaPickerUrl !== undefined) {
      // Selecting an asset writes its id straight back into the mediaId input,
      // so `save` keeps reading the same `data-field` value with no extra state.
      const picker = buildPicker(factory, this._mediaPickerUrl, ({ id }) => {
        const input = mediaId.querySelector(`[data-field="mediaId"]`);
        if (input !== null) {
          input.value = id;
        }
      });
      wrapper.appendChild(picker.button);
      wrapper.appendChild(picker.host);
    }
    wrapper.appendChild(field(factory, 'alt', this._data.alt ?? '', 'Alt'));
    wrapper.appendChild(field(factory, 'caption', this._data.caption ?? '', 'Caption'));
    return wrapper;
  }

  save(block: SaveBlock): ImageData {
    return {
      mediaId: readField(block, 'mediaId'),
      ...(readField(block, 'alt') !== '' ? { alt: readField(block, 'alt') } : {}),
      ...(readField(block, 'caption') !== '' ? { caption: readField(block, 'caption') } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export class GalleryTool {
  private readonly _data: GalleryData;
  private readonly _mediaPickerUrl: string | undefined;

  static get toolbox(): ToolboxDescriptor {
    return { icon: 'GAL', title: 'Gallery' };
  }

  constructor({ data, config }: BlockToolConstructorOptions<GalleryData, MediaPickerToolConfig>) {
    this._data = {
      mediaIds: Array.isArray(data.mediaIds) ? [...data.mediaIds] : [],
      ...(typeof data.alt === 'string' && data.alt !== '' ? { alt: data.alt } : {}),
    };
    this._mediaPickerUrl = resolveMediaPickerUrl(config);
  }

  render(): DomNode {
    const factory = domFactory();
    const wrapper = factory.createElement('div');
    const mediaIds = field(factory, 'mediaIds', this._data.mediaIds.join(','), 'Media ids');
    wrapper.appendChild(mediaIds);
    if (this._mediaPickerUrl !== undefined) {
      // Gallery selection toggles ids in a Set seeded from the current input,
      // then writes the joined list back so `save` reads the same data-field.
      const picker = buildPicker(factory, this._mediaPickerUrl, ({ id }) => {
        const input = mediaIds.querySelector(`[data-field="mediaIds"]`);
        const current = input?.value ?? '';
        const selected = new Set(
          current
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== ''),
        );
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          selected.add(id);
        }
        if (input !== null) {
          input.value = [...selected].join(',');
        }
      });
      wrapper.appendChild(picker.button);
      wrapper.appendChild(picker.host);
    }
    wrapper.appendChild(field(factory, 'alt', this._data.alt ?? '', 'Alt'));
    return wrapper;
  }

  save(block: SaveBlock): GalleryData {
    const mediaIds = readField(block, 'mediaIds')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    return {
      mediaIds,
      ...(readField(block, 'alt') !== '' ? { alt: readField(block, 'alt') } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

export class EmbedTool {
  private readonly _data: EmbedData;

  static get toolbox(): ToolboxDescriptor {
    return { icon: 'EMB', title: 'Embed' };
  }

  constructor({ data }: BlockToolConstructorOptions<EmbedData>) {
    this._data = { url: typeof data.url === 'string' ? data.url : '' };
  }

  render(): DomNode {
    const factory = domFactory();
    const wrapper = factory.createElement('div');
    wrapper.appendChild(field(factory, 'url', this._data.url, 'URL'));
    return wrapper;
  }

  save(block: SaveBlock): EmbedData {
    return { url: readField(block, 'url') };
  }
}

// ---------------------------------------------------------------------------
// Callout
// ---------------------------------------------------------------------------

export class CalloutTool {
  private readonly _data: CalloutData;

  static get toolbox(): ToolboxDescriptor {
    return { icon: 'CAL', title: 'Callout' };
  }

  constructor({ data }: BlockToolConstructorOptions<CalloutData>) {
    const tone =
      data.tone === 'warning' || data.tone === 'danger' || data.tone === 'success'
        ? data.tone
        : 'info';
    this._data = { tone, text: typeof data.text === 'string' ? data.text : '' };
  }

  render(): DomNode {
    const factory = domFactory();
    const wrapper = factory.createElement('div');
    wrapper.appendChild(field(factory, 'text', this._data.text, 'Text'));
    wrapper.appendChild(field(factory, 'tone', this._data.tone, 'Tone'));
    return wrapper;
  }

  save(block: SaveBlock): CalloutData {
    const tone = readField(block, 'tone');
    const normalized: CalloutData['tone'] =
      tone === 'warning' || tone === 'danger' || tone === 'success' ? tone : 'info';
    return { tone: normalized, text: readField(block, 'text') };
  }
}

// ---------------------------------------------------------------------------
// CTA
// ---------------------------------------------------------------------------

export class CtaTool {
  private readonly _data: CtaData;

  static get toolbox(): ToolboxDescriptor {
    return { icon: 'CTA', title: 'CTA' };
  }

  constructor({ data }: BlockToolConstructorOptions<CtaData>) {
    this._data = {
      label: typeof data.label === 'string' ? data.label : '',
      href: typeof data.href === 'string' ? data.href : '',
    };
  }

  render(): DomNode {
    const factory = domFactory();
    const wrapper = factory.createElement('div');
    wrapper.appendChild(field(factory, 'label', this._data.label, 'Label'));
    wrapper.appendChild(field(factory, 'href', this._data.href, 'Link'));
    return wrapper;
  }

  save(block: SaveBlock): CtaData {
    return { label: readField(block, 'label'), href: readField(block, 'href') };
  }
}
