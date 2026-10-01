/**
 * The eager trigger listener: which events are server-component triggers,
 * that every one has its default prevented at once in the capture phase and
 * is dispatched in the bubble phase (so a listener below can veto it) unless
 * marked `.capture`, the bounded in-order replay once the queue opens, holding
 * again, and disposal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Window } from 'happy-dom';

import {
  MAX_QUEUED_TRIGGERS,
  createTriggerQueue,
  resolveTrigger,
  type ComponentTrigger,
  type TriggerDocument,
  type TriggerElement,
} from '../../src/client/trigger-queue.js';
import type { JsailsEvent } from '../../src/client/islands.js';
import {
  CALL_ATTRIBUTE,
  CAPTURE_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import { ISLAND_ATTRIBUTE } from '../../src/client/islands.js';

interface FakeElement extends TriggerElement {
  parent: FakeElement | null;
  isConnected: boolean;
  readonly label: string;
}

function element(
  label: string,
  attributes: Record<string, string> = {},
  parent: FakeElement | null = null,
): FakeElement {
  const attrs = new Map(Object.entries(attributes));
  const node: FakeElement = {
    label,
    parent,
    id: '',
    isConnected: true,
    innerHTML: '',
    textContent: null,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      attrs.set(name, value);
    },
    removeAttribute: (name) => {
      attrs.delete(name);
    },
    hasAttribute: (name) => attrs.has(name),
    querySelectorAll: () => [],
    closest(selector) {
      const name = /^\[([^\]]+)\]$/.exec(selector)?.[1];
      for (let current: FakeElement | null = node; current !== null; current = current.parent) {
        if (name !== undefined && current.hasAttribute(name)) {
          return current;
        }
      }
      return null;
    },
  };
  return node;
}

function event(type: string, target: FakeElement | null): JsailsEvent & { prevented: number } {
  const e = {
    type,
    target,
    prevented: 0,
    preventDefault() {
      e.prevented += 1;
    },
  };
  return e;
}

interface Doc extends TriggerDocument {
  readonly listeners: Array<{ type: string; listener: (e: JsailsEvent) => void; options: unknown }>;
  /** Dispatch through both phases at the document. */
  fire(e: JsailsEvent): void;
  /** Dispatch as if a listener below the document stopped propagation. */
  fireStopped(e: JsailsEvent): void;
}

const isCapture = (options: unknown): boolean =>
  typeof options === 'object' &&
  options !== null &&
  'capture' in options &&
  options.capture === true;

function doc(): Doc {
  const listeners: Doc['listeners'] = [];
  const phase = (e: JsailsEvent, capture: boolean): void => {
    for (const l of listeners.filter(
      (entry) => entry.type === e.type && isCapture(entry.options) === capture,
    )) {
      l.listener(e);
    }
  };
  return {
    listeners,
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener, options) {
      const index = listeners.findIndex(
        (l) =>
          l.type === type && l.listener === listener && isCapture(l.options) === isCapture(options),
      );
      if (index !== -1) listeners.splice(index, 1);
    },
    fire(e) {
      phase(e, true);
      phase(e, false);
    },
    fireStopped(e) {
      phase(e, true);
    },
  };
}

/** A component root with a bound form, a call button, and a sort header. */
function page() {
  const root = element('root', { [COMPONENT_ATTRIBUTE]: 'tasks' });
  const form = element('form', { [SUBMIT_ATTRIBUTE]: 'add' }, root);
  const input = element('input', {}, form);
  const button = element('button', { [CALL_ATTRIBUTE]: 'remove' }, root);
  const icon = element('icon', {}, button);
  const header = element('th', { [SORT_ATTRIBUTE]: 'title' }, root);
  return { root, form, input, button, icon, header };
}

const describeTrigger = (trigger: ComponentTrigger | null): string | null =>
  trigger === null ? null : `${trigger.kind}:${(trigger.element as FakeElement).label}`;

describe('resolveTrigger', () => {
  it('resolves a bound form submit, a call click (through its children), and a sort click', () => {
    const p = page();
    assert.equal(describeTrigger(resolveTrigger(event('submit', p.form))), 'submit:form');
    assert.equal(describeTrigger(resolveTrigger(event('click', p.icon))), 'call:button');
    assert.equal(describeTrigger(resolveTrigger(event('click', p.header))), 'sort:th');
  });

  it('prefers a call marker over an enclosing sort marker', () => {
    const p = page();
    const inner = element('a', { [CALL_ATTRIBUTE]: 'open' }, p.header);
    assert.equal(describeTrigger(resolveTrigger(event('click', inner))), 'call:a');
  });

  it('ignores other events, unmarked elements, and empty markers', () => {
    const p = page();
    assert.equal(resolveTrigger(event('input', p.input)), null);
    assert.equal(resolveTrigger(event('click', p.input)), null);
    assert.equal(resolveTrigger(event('click', null)), null);
    const empty = element('button', { [CALL_ATTRIBUTE]: '' }, p.root);
    assert.equal(resolveTrigger(event('click', empty)), null);
    const emptyForm = element('form', { [SUBMIT_ATTRIBUTE]: '' }, p.root);
    assert.equal(resolveTrigger(event('submit', emptyForm)), null);
  });

  it('ignores triggers outside a component root, inside an island, or in an ignored subtree', () => {
    const loose = element('button', { [CALL_ATTRIBUTE]: 'save' });
    assert.equal(resolveTrigger(event('click', loose)), null);

    const p = page();
    const island = element('island', { [ISLAND_ATTRIBUTE]: 'counter' }, p.root);
    const islandForm = element('form', { [SUBMIT_ATTRIBUTE]: 'save' }, island);
    assert.equal(resolveTrigger(event('submit', islandForm)), null);

    const ignored = element('div', { [IGNORE_ATTRIBUTE]: '' }, p.root);
    const ignoredButton = element('button', { [CALL_ATTRIBUTE]: 'save' }, ignored);
    assert.equal(resolveTrigger(event('click', ignoredButton)), null);
  });

  it('never falls back to a sort marker when the call trigger is out of scope', () => {
    const p = page();
    const ignored = element('div', { [IGNORE_ATTRIBUTE]: '' }, p.header);
    const button = element('button', { [CALL_ATTRIBUTE]: 'save' }, ignored);
    assert.equal(resolveTrigger(event('click', button)), null);
  });
});

describe('createTriggerQueue', () => {
  it('installs one capturing and one bubbling listener each for submit and click', () => {
    const d = doc();
    createTriggerQueue(d);
    assert.deepEqual(
      d.listeners.map((l) => [l.type, isCapture(l.options)]),
      [
        ['submit', true],
        ['click', true],
        ['submit', false],
        ['click', false],
      ],
    );
  });

  it('dispatches in the bubble phase, so a listener below that stops the event vetoes it', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    const ran: string[] = [];
    queue.open((trigger) => ran.push(describeTrigger(trigger)!));

    const stopped = event('submit', p.form);
    d.fireStopped(stopped);
    assert.equal(stopped.prevented, 1, 'its default is still prevented in the capture phase');
    assert.equal(ran.length, 0);

    queue.hold();
    d.fireStopped(event('click', p.button));
    assert.equal(queue.size, 0, 'a vetoed trigger is not held either');

    queue.open((trigger) => ran.push(describeTrigger(trigger)!));
    d.fire(event('submit', p.form));
    assert.deepEqual(ran, ['submit:form']);
  });

  it('dispatches a .capture trigger in the capture phase, before anything below can stop it', () => {
    const d = doc();
    const p = page();
    const eager = element('button', { [CALL_ATTRIBUTE]: 'go', [CAPTURE_ATTRIBUTE]: '' }, p.root);
    const queue = createTriggerQueue(d);
    const ran: string[] = [];
    queue.open((trigger) => ran.push(describeTrigger(trigger)!));
    d.fireStopped(event('click', eager));
    assert.deepEqual(ran, ['call:button']);
    d.fire(event('click', eager));
    assert.deepEqual(ran, ['call:button', 'call:button'], 'dispatched once per event');
  });

  it('lets a form-level capture guard hold a submit and resubmit it, dispatching once', async () => {
    // A form-level guard that holds every submit of its form, saves into a
    // hidden input, then resubmits.
    const window = new Window({ url: 'http://localhost/' });
    try {
      const document = window.document;
      document.body.innerHTML =
        `<div ${COMPONENT_ATTRIBUTE}="post"><form ${SUBMIT_ATTRIBUTE}="save" method="dialog">` +
        '<input type="hidden" name="body" value="OLD" /><button type="submit">Save</button>' +
        '</form></div>';
      const form = document.querySelector('form')!;
      const input = document.querySelector('input')!;
      const queue = createTriggerQueue(document as unknown as TriggerDocument);
      const dispatched: string[] = [];
      queue.open(() => dispatched.push(input.value));

      let releasing = false;
      form.addEventListener(
        'submit',
        (submit) => {
          if (releasing) return;
          submit.preventDefault();
          submit.stopImmediatePropagation();
          queueMicrotask(() => {
            input.value = 'NEW';
            releasing = true;
            try {
              form.requestSubmit();
            } finally {
              releasing = false;
            }
          });
        },
        true,
      );

      document.querySelector('button')!.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(dispatched, ['NEW'], 'one dispatch, with the saved value');
      queue.dispose();
    } finally {
      await window.happyDOM.close();
    }
  });

  it('prevents a trigger at once and holds it until opened, then replays in order', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    const submit = event('submit', p.form);
    const click = event('click', p.icon);
    const sort = event('click', p.header);
    d.fire(submit);
    d.fire(click);
    d.fire(sort);
    assert.deepEqual([submit.prevented, click.prevented, sort.prevented], [1, 1, 1]);
    assert.equal(queue.size, 3);

    const ran: string[] = [];
    queue.open((trigger) => ran.push(describeTrigger(trigger)!));
    assert.deepEqual(ran, ['submit:form', 'call:button', 'sort:th']);
    assert.equal(queue.size, 0);

    // Open: later triggers run at once, still with their default prevented.
    const live = event('submit', p.form);
    d.fire(live);
    assert.equal(live.prevented, 1);
    assert.deepEqual(ran, ['submit:form', 'call:button', 'sort:th', 'submit:form']);
  });

  it('leaves a non-trigger event alone', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    const plain = event('click', p.input);
    d.fire(plain);
    assert.equal(plain.prevented, 0);
    assert.equal(queue.size, 0);
  });

  it('holds at most MAX_QUEUED_TRIGGERS, preventing and dropping the rest', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    const events = Array.from({ length: MAX_QUEUED_TRIGGERS + 3 }, () => event('click', p.button));
    for (const e of events) d.fire(e);
    assert.ok(events.every((e) => e.prevented === 1));
    assert.equal(queue.size, MAX_QUEUED_TRIGGERS);
    let ran = 0;
    queue.open(() => {
      ran += 1;
    });
    assert.equal(ran, MAX_QUEUED_TRIGGERS);
  });

  it('skips a held trigger whose element left the document', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    d.fire(event('click', p.button));
    d.fire(event('submit', p.form));
    p.button.isConnected = false;
    const ran: string[] = [];
    queue.open((trigger) => ran.push(describeTrigger(trigger)!));
    assert.deepEqual(ran, ['submit:form']);
  });

  it('holds again after hold() and replays on the next open()', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    const first: string[] = [];
    queue.open((trigger) => first.push(describeTrigger(trigger)!));
    queue.hold();
    d.fire(event('click', p.header));
    assert.deepEqual(first, []);
    const second: string[] = [];
    queue.open((trigger) => second.push(describeTrigger(trigger)!));
    assert.deepEqual(second, ['sort:th']);
  });

  it('dispose removes both listeners, drops held triggers, and ignores a later open', () => {
    const d = doc();
    const p = page();
    const queue = createTriggerQueue(d);
    d.fire(event('click', p.button));
    queue.dispose();
    queue.dispose();
    assert.equal(d.listeners.length, 0);
    assert.equal(queue.size, 0);
    let ran = 0;
    queue.open(() => {
      ran += 1;
    });
    assert.equal(ran, 0);
  });
});
