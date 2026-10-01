/**
 * Browser-safe action attribute builder tests.
 *
 * These are direct unit tests for the builders shared by the server-component
 * directive helpers and the client island runtime: option validation, the
 * emitted attribute map, and the debounce/poll bounds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindAttrs,
  callAttrs,
  confirmAttrs,
  ignoreAttrs,
  loadingTargetAttrs,
  pollAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  submitAttrs,
  textAttrs,
} from '../../src/client/action-attrs.js';
import { ServerComponentRuntimeError } from '../../src/server-components/runtime/value-errors.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';

describe('action attrs: bindAttrs', () => {
  it('emits the model marker', () => {
    assert.deepEqual(bindAttrs('name'), { [MODEL_ATTRIBUTE]: 'name' });
  });

  it('emits the debounce marker when a duration is supplied', () => {
    assert.deepEqual(bindAttrs('q', { debounceMs: 250 }), {
      [MODEL_ATTRIBUTE]: 'q',
      [DEBOUNCE_ATTRIBUTE]: '250',
    });
  });

  it('rejects an empty name', () => {
    assert.throws(() => bindAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => bindAttrs('   '), ServerComponentRuntimeError);
  });

  it('rejects a debounce outside 1..MAX_DEBOUNCE_MS', () => {
    for (const debounceMs of [0, -1, 1.5, MAX_DEBOUNCE_MS + 1, Number.NaN]) {
      assert.throws(() => bindAttrs('q', { debounceMs }), ServerComponentRuntimeError);
    }
  });
});

describe('action attrs: callAttrs', () => {
  it('emits the call marker without args', () => {
    assert.deepEqual(callAttrs('save'), { [CALL_ATTRIBUTE]: 'save' });
  });

  it('serializes args into the args marker', () => {
    assert.deepEqual(callAttrs('save', { id: 7 }), {
      [CALL_ATTRIBUTE]: 'save',
      [ARGS_ATTRIBUTE]: '{"id":7}',
    });
  });

  it('rejects an empty action', () => {
    assert.throws(() => callAttrs(''), ServerComponentRuntimeError);
  });
});

describe('action attrs: submitAttrs', () => {
  it('emits the submit marker without args', () => {
    assert.deepEqual(submitAttrs('save'), { [SUBMIT_ATTRIBUTE]: 'save' });
  });

  it('serializes args into the args marker', () => {
    assert.deepEqual(submitAttrs('save', { id: 3 }), {
      [SUBMIT_ATTRIBUTE]: 'save',
      [ARGS_ATTRIBUTE]: '{"id":3}',
    });
  });

  it('rejects an empty action', () => {
    assert.throws(() => submitAttrs(''), ServerComponentRuntimeError);
  });
});

describe('action attrs: pollAttrs', () => {
  it('emits the poll marker with the interval', () => {
    assert.deepEqual(pollAttrs({ intervalMs: MIN_POLL_INTERVAL_MS }), {
      [POLL_ATTRIBUTE]: `{"intervalMs":${MIN_POLL_INTERVAL_MS}}`,
    });
  });

  it('includes the pause flags when supplied', () => {
    assert.deepEqual(
      pollAttrs({ intervalMs: 1000, pauseWhenHidden: true, pauseWhenOffline: false }),
      {
        [POLL_ATTRIBUTE]: '{"intervalMs":1000,"pauseWhenHidden":true,"pauseWhenOffline":false}',
      },
    );
  });

  it('rejects an interval below the minimum or non-integer', () => {
    for (const intervalMs of [MIN_POLL_INTERVAL_MS - 1, 0, 1.5, Number.NaN]) {
      assert.throws(() => pollAttrs({ intervalMs }), ServerComponentRuntimeError);
    }
  });
});

describe('action attrs: directive builders', () => {
  it('emits each directive marker', () => {
    assert.deepEqual(confirmAttrs('Sure?'), { [CONFIRM_ATTRIBUTE]: 'Sure?' });
    assert.deepEqual(loadingTargetAttrs('#spinner'), {
      [LOADING_TARGET_ATTRIBUTE]: '#spinner',
    });
    assert.deepEqual(showAttrs('visible'), { [SHOW_ATTRIBUTE]: 'visible' });
    assert.deepEqual(textAttrs('label'), { [TEXT_ATTRIBUTE]: 'label' });
    assert.deepEqual(sortAttrs('title'), { [SORT_ATTRIBUTE]: 'title' });
    assert.deepEqual(refAttrs('target'), { [REF_ATTRIBUTE]: 'target' });
    assert.deepEqual(ignoreAttrs(), { [IGNORE_ATTRIBUTE]: '' });
  });

  it('rejects empty directive arguments', () => {
    assert.throws(() => confirmAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => loadingTargetAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => showAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => textAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => sortAttrs(''), ServerComponentRuntimeError);
    assert.throws(() => refAttrs(''), ServerComponentRuntimeError);
  });

  it('rejects a ref name with whitespace or markup characters', () => {
    for (const name of ['a b', 'a"b', 'a<b', 'a>b']) {
      assert.throws(() => refAttrs(name), ServerComponentRuntimeError);
    }
  });
});
