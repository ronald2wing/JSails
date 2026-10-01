/**
 * Node views of the atom blocks (image, gallery, embed, call to action): a
 * `figure` of plain controls bound to the block's attributes, since none of
 * them holds text the author types in place.
 *
 * - Image: media id (with the media picker when the field has one), alt
 *   text and caption. Gallery: media ids (one per line, the picker appends)
 *   and alt text. Embed: the `https:` URL. Call to action: label and link.
 * - Every value is checked with the schema's attribute rule before it is
 *   written (`attribute-controls.ts`), so the node can never hold a value the
 *   model refuses.
 * - A Remove button deletes the block, so a keyboard user does not need to
 *   select the node first.
 * - The view owns its events (ProseMirror ignores them) and its DOM changes
 *   (ProseMirror does not re-read them); a selected atom shows
 *   ProseMirror's selected-node class.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';

import { MAX_GALLERY_ITEMS, MAX_MEDIA_ID_LENGTH } from 'jsails/rich-text';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';

import { createMediaPicker } from '../ui/media-picker.js';
import {
  createAttributeControl,
  type AttributeControl,
  type AttributeControlSpec,
} from './attribute-controls.js';

/** The atom node names this module draws. */
export type AtomViewName = 'image' | 'gallery' | 'embed' | 'cta';

interface AtomSpec {
  readonly title: string;
  readonly controls: readonly AttributeControlSpec[];
  /** The attribute the media picker writes, and how. */
  readonly picker?: { readonly attribute: string; readonly mode: 'replace' | 'append' };
}

const MEDIA_ID_MESSAGE = `Enter a media id of at most ${String(MAX_MEDIA_ID_LENGTH)} characters, on one line.`;
const TEXT_MESSAGE = 'Use one line of text without control characters, within the length limit.';

/** The controls of each atom, in display order. */
export const ATOM_SPECS: Readonly<Record<AtomViewName, AtomSpec>> = Object.freeze({
  image: {
    title: 'Image',
    controls: [
      { attribute: 'mediaId', label: 'Media id', invalidMessage: MEDIA_ID_MESSAGE },
      { attribute: 'alt', label: 'Alt text', invalidMessage: TEXT_MESSAGE },
      { attribute: 'caption', label: 'Caption', invalidMessage: TEXT_MESSAGE },
    ],
    picker: { attribute: 'mediaId', mode: 'replace' },
  },
  gallery: {
    title: 'Gallery',
    controls: [
      {
        attribute: 'mediaIds',
        label: 'Media ids (one per line)',
        kind: 'lines',
        invalidMessage: `Enter between 1 and ${String(MAX_GALLERY_ITEMS)} media ids, one per line.`,
      },
      { attribute: 'alt', label: 'Alt text', invalidMessage: TEXT_MESSAGE },
    ],
    picker: { attribute: 'mediaIds', mode: 'append' },
  },
  embed: {
    title: 'Embed',
    controls: [
      {
        attribute: 'url',
        label: 'Embed URL',
        invalidMessage: 'Enter an https:// URL with a host and no user name.',
      },
    ],
  },
  cta: {
    title: 'Call to action',
    controls: [
      { attribute: 'label', label: 'Button label', invalidMessage: TEXT_MESSAGE },
      {
        attribute: 'href',
        label: 'Link',
        invalidMessage:
          'Enter a path such as /pricing, a #fragment, an http(s) URL, mailto: or tel:.',
      },
    ],
  },
});

class AtomView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly controls: AttributeControl[];

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    name: AtomViewName,
    pickerUrl: string | undefined,
  ) {
    const spec = ATOM_SPECS[name];
    this.node = node;
    this.dom = document.createElement('figure');
    this.dom.className = `rich-text-editor-block rich-text-editor-${name}`;
    this.dom.contentEditable = 'false';
    this.dom.setAttribute('data-rich-text', name);
    const heading = document.createElement('figcaption');
    heading.textContent = spec.title;
    this.controls = spec.controls.map((control) =>
      createAttributeControl(view, name, getPos, node, control),
    );
    const parts: HTMLElement[] = [heading, ...this.controls.map((control) => control.element)];
    const picker = spec.picker;
    if (picker !== undefined && pickerUrl !== undefined) {
      const target =
        this.controls[spec.controls.findIndex((c) => c.attribute === picker.attribute)];
      if (target !== undefined) {
        parts.push(
          createMediaPicker({
            url: pickerUrl,
            onSelect: (item) => {
              const current = target.control.value.trim();
              target.control.value =
                picker.mode === 'append' && current !== '' ? `${current}\n${item.id}` : item.id;
              target.control.dispatchEvent(new Event('change'));
            },
          }),
        );
      }
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rich-text-editor-remove';
    remove.textContent = `Remove ${spec.title.toLowerCase()}`;
    remove.addEventListener('click', () => {
      const pos = getPos();
      if (pos !== undefined) {
        view.dispatch(view.state.tr.delete(pos, pos + this.node.nodeSize));
        view.focus();
      }
    });
    parts.push(remove);
    this.dom.append(...parts);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) {
      return false;
    }
    this.node = node;
    for (const control of this.controls) {
      control.refresh(node);
    }
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return (
      target !== null &&
      target !== this.dom &&
      target.closest('input, textarea, select, button') !== null
    );
  }

  ignoreMutation(): boolean {
    return true;
  }
}

/** The node view constructor of atom `name`, with the media picker at `pickerUrl` when given. */
export function atomView(name: AtomViewName, pickerUrl: string | undefined): NodeViewConstructor {
  return (node, view, getPos) => new AtomView(node, view, getPos, name, pickerUrl);
}
