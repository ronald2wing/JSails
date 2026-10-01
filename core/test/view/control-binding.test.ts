/**
 * Tests for bindControl and emitter. bindControl reads a control's value or checked state from its target and writes the control back under the live client's value rules: trim, number and numeric inputs convert to finite numbers, the raw text survives a re-render while it still means the target's value, change normalises what the control shows, and lazy waits for change; the control's own input and change handlers run after the binding's, never instead of it. emitter calls the handler prop of an event when the parent set one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindControl,
  emitter,
  type ControlEvent,
  type ControlTarget,
} from '../../src/view/index.js';

function control(
  value: string,
  checked = false,
): ControlEvent & {
  readonly currentTarget: { value: string; checked: boolean };
} {
  return { currentTarget: { value, checked } };
}

function target<T>(value: T): ControlTarget<T> {
  return { value };
}

describe('bindControl: text', () => {
  it('reads the target and writes each input', () => {
    const title = target('a');
    const attributes = bindControl(title, 'text');
    assert.equal(attributes.value, 'a');
    attributes.onInput?.(control('ab'));
    assert.equal(title.value, 'ab');
    assert.equal(attributes.onChange, undefined);
  });

  it('trims into the target, keeps the raw text while typing, and settles on change', () => {
    const name = target('');
    bindControl(name, 'text', { trim: true }).onInput?.(control('ann '));
    assert.equal(name.value, 'ann');
    const typing = bindControl(name, 'text', { trim: true });
    assert.equal(typing.value, 'ann ', 'the trailing space survives a re-render');
    const field = control('ann ');
    typing.onChange?.(field);
    assert.equal(field.currentTarget.value, 'ann');
    assert.equal(bindControl(name, 'text', { trim: true }).value, 'ann');
  });

  it('shows the target once it changes elsewhere', () => {
    const name = target('');
    bindControl(name, 'text', { trim: true }).onInput?.(control('x '));
    name.value = 'reset';
    assert.equal(bindControl(name, 'text', { trim: true }).value, 'reset');
  });

  it('converts with number, and keeps text that is not a number', () => {
    const amount = target<string | number>('');
    const attributes = bindControl(amount, 'text', { number: true });
    attributes.onInput?.(control(' 1.5 '));
    assert.equal(amount.value, 1.5);
    attributes.onInput?.(control('1.5x'));
    assert.equal(amount.value, '1.5x');
    attributes.onInput?.(control('Infinity'));
    assert.equal(amount.value, 'Infinity');
  });

  it('writes on change only when lazy, keeping the pending text across renders', () => {
    const note = target('a');
    bindControl(note, 'text', { lazy: true }).onInput?.(control('ab'));
    assert.equal(note.value, 'a');
    const pending = bindControl(note, 'text', { lazy: true });
    assert.equal(pending.value, 'ab');
    pending.onChange?.(control('ab'));
    assert.equal(note.value, 'ab');
    assert.equal(bindControl(note, 'text', { lazy: true }).value, 'ab');
  });
});

describe('bindControl: number', () => {
  it('holds a finite number, or an empty string while the input is empty', () => {
    const count = target<string | number>(3);
    const attributes = bindControl(count, 'number');
    assert.equal(attributes.value, '3');
    attributes.onInput?.(control('4'));
    assert.equal(count.value, 4);
    attributes.onInput?.(control(''));
    assert.equal(count.value, '');
  });

  it('keeps "1." while typing and shows the number on change', () => {
    const count = target<string | number>(0);
    bindControl(count, 'number').onInput?.(control('1.'));
    assert.equal(count.value, 1);
    const typing = bindControl(count, 'number');
    assert.equal(typing.value, '1.');
    const field = control('1.');
    typing.onChange?.(field);
    assert.equal(field.currentTarget.value, '1');
  });
});

describe('bindControl: checkbox, radio and select', () => {
  it('binds a checkbox to a boolean', () => {
    const done = target(false);
    const attributes = bindControl(done, 'checkbox');
    assert.equal(attributes.checked, false);
    attributes.onChange(control('on', true));
    assert.equal(done.value, true);
  });

  it('checks the radio whose value the target holds, and writes it when checked', () => {
    const size = target('s');
    const small = bindControl(size, 'radio', { value: 's' });
    const large = bindControl(size, 'radio', { value: 'l' });
    assert.deepEqual([small.checked, large.checked, large.value], [true, false, 'l']);
    large.onChange(control('l', true));
    assert.equal(size.value, 'l');
    small.onChange(control('s', false));
    assert.equal(size.value, 'l');
  });

  it('binds a select, converting with number', () => {
    const choice = target<string | number>(2);
    const attributes = bindControl(choice, 'select', { number: true });
    assert.equal(attributes.value, '2');
    attributes.onChange?.(control('3'));
    assert.equal(choice.value, 3);
    const plain = target('a');
    bindControl(plain, 'select').onChange?.(control('7'));
    assert.equal(plain.value, '7');
  });
});

describe("bindControl: the control's own handlers", () => {
  it('runs each after the binding wrote the target, with the same event', () => {
    const title = target('');
    const seen: [string, string][] = [];
    const attributes = bindControl(title, 'text', {
      handlers: { onInput: (event) => seen.push([event.currentTarget.value, title.value]) },
    });
    attributes.onInput?.(control('ab'));
    assert.equal(title.value, 'ab');
    assert.deepEqual(seen, [['ab', 'ab']]);
  });

  it('joins the binding on change too, or sets a handler the binding has none of', () => {
    const name = target('');
    const changes: string[] = [];
    const settling = bindControl(name, 'text', {
      trim: true,
      handlers: { onChange: () => changes.push(name.value) },
    });
    settling.onInput?.(control(' x '));
    const field = control(' x ');
    settling.onChange?.(field);
    assert.equal(field.currentTarget.value, 'x', 'the binding settled the control');
    assert.deepEqual(changes, ['x']);

    const plain = bindControl(name, 'text', {
      handlers: { onChange: () => changes.push('plain') },
    });
    plain.onChange?.(control('y'));
    assert.deepEqual(changes, ['x', 'plain']);
  });

  it('keeps a lazy binding pending on input and writes it on change, before each handler', () => {
    const query = target('');
    const seen: string[] = [];
    const attributes = bindControl(query, 'text', {
      lazy: true,
      handlers: {
        onInput: () => seen.push(`input:${query.value}`),
        onChange: () => seen.push(`change:${query.value}`),
      },
    });
    attributes.onInput?.(control('q'));
    attributes.onChange?.(control('q'));
    assert.deepEqual(seen, ['input:', 'change:q']);
  });

  it('toggles a checkbox and selects a radio before their change handlers', () => {
    const open = target(false);
    const opened: boolean[] = [];
    bindControl(open, 'checkbox', {
      handlers: { onChange: () => opened.push(open.value) },
    }).onChange(control('on', true));
    assert.deepEqual(opened, [true]);

    const size = target('s');
    const picked: string[] = [];
    bindControl(size, 'radio', {
      value: 'm',
      handlers: { onChange: () => picked.push(size.value) },
    }).onChange(control('m', true));
    assert.deepEqual(picked, ['m']);
  });

  it('leaves the binding as it is without handlers', () => {
    const title = target('');
    const attributes = bindControl(title, 'text', { handlers: {} });
    assert.equal(attributes.onChange, undefined);
    attributes.onInput?.(control('a'));
    assert.equal(title.value, 'a');
  });
});

describe('emitter', () => {
  it('calls the handler prop of an event with its arguments', () => {
    const calls: unknown[][] = [];
    const emit = emitter<{ change: [value: number]; close: [] }>({
      onChange: (value) => calls.push(['change', value]),
    });
    emit('change', 3);
    emit('close');
    assert.deepEqual(calls, [['change', 3]]);
  });

  it('ignores a handler prop that is not a function', () => {
    const emit = emitter<{ open: [] }>({ onOpen: 'nope' } as unknown as { onOpen?: () => void });
    assert.doesNotThrow(() => emit('open'));
  });
});
