/**
 * Node views of the textblocks that carry an attribute besides their text:
 * a callout's tone, a quote's citation and a code block's language. The text
 * stays ProseMirror's (the view's `contentDOM`), and the attribute gets a
 * plain control beside it (`attribute-controls.ts`), outside the editable
 * content, whose events and DOM changes ProseMirror leaves to the view.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from 'prosemirror-view';

import { CALLOUT_TONES } from 'jsails/rich-text';

import {
  createAttributeControl,
  type AttributeControl,
  type AttributeControlSpec,
} from './attribute-controls.js';

/** The textblock node names this module draws. */
export type TextblockViewName = 'callout' | 'quote' | 'code_block';

const TONE_LABELS: Readonly<Record<string, string>> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  danger: 'Danger',
};

const CONTROLS: Readonly<Record<TextblockViewName, AttributeControlSpec>> = Object.freeze({
  callout: {
    attribute: 'tone',
    label: 'Tone',
    kind: 'select',
    options: CALLOUT_TONES.map((tone) => ({ value: tone, label: TONE_LABELS[tone] ?? tone })),
    invalidMessage: 'Choose one of the listed tones.',
  },
  quote: {
    attribute: 'citation',
    label: 'Citation',
    invalidMessage: 'Use one line of text without control characters, within the length limit.',
  },
  code_block: {
    attribute: 'language',
    label: 'Language',
    invalidMessage: 'Use one short line without control characters.',
  },
});

/** The element holding the block and the element holding its text, per block. */
function frame(name: TextblockViewName): {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  slot: HTMLElement;
} {
  const slot = document.createElement('div');
  slot.className = 'rich-text-editor-block-controls';
  slot.contentEditable = 'false';
  if (name === 'code_block') {
    const dom = document.createElement('div');
    dom.className = 'rich-text-editor-code';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.append(code);
    dom.append(slot, pre);
    return { dom, contentDOM: code, slot };
  }
  const dom = document.createElement(name === 'callout' ? 'aside' : 'blockquote');
  dom.className = `rich-text-editor-${name}`;
  const contentDOM = document.createElement('div');
  contentDOM.className = 'rich-text-editor-content';
  dom.append(contentDOM, slot);
  return { dom, contentDOM, slot };
}

class TextblockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private node: ProseMirrorNode;
  private readonly control: AttributeControl;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly name: TextblockViewName,
  ) {
    this.node = node;
    const { dom, contentDOM, slot } = frame(name);
    this.dom = dom;
    this.contentDOM = contentDOM;
    this.control = createAttributeControl(view, name, getPos, node, CONTROLS[name]);
    slot.append(this.control.element);
    this.reflect();
  }

  /** Mirror the tone on the element, for styling. */
  private reflect(): void {
    if (this.name === 'callout') {
      this.dom.setAttribute('data-tone', String(this.node.attrs.tone));
    }
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) {
      return false;
    }
    this.node = node;
    this.control.refresh(node);
    this.reflect();
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target as Node | null;
    return target !== null && this.control.element.contains(target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') {
      return false;
    }
    return !this.contentDOM.contains(mutation.target);
  }
}

/** The node view constructor of textblock `name`. */
export function textblockView(name: TextblockViewName): NodeViewConstructor {
  return (node, view, getPos) => new TextblockView(node, view, getPos, name);
}
