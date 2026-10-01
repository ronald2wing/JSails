/** Keyed and live service tokens: families, `named(key)` members, the live flag, and the token guard. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createServiceRegistry,
  createServiceToken,
  isServiceToken,
  ServiceErrors,
} from '../../src/extensions/services.js';

describe('keyed service tokens', () => {
  it('a family hands out one member per key, named after both', () => {
    const disk = createServiceToken<string>('disk');
    const media = disk.named('media');
    assert.equal(media, disk.named('media'));
    assert.notEqual(media, disk.named('backups'));
    assert.equal(media.name, 'disk:media');
    assert.equal(media.family, disk);
    assert.equal(media.key, 'media');
    assert.equal(disk.family, undefined);
    assert.ok(Object.isFrozen(disk) && Object.isFrozen(media));
  });

  it('members of two families with one name stay distinct services', () => {
    const first = createServiceToken<string>('disk');
    const second = createServiceToken<string>('disk');
    const controller = createServiceRegistry();
    controller.registrar.provide(first.named('media'), 'a');
    controller.registrar.provide(second.named('media'), 'b');
    assert.equal(controller.services.get(first.named('media')), 'a');
    assert.equal(controller.services.get(second.named('media')), 'b');
    assert.equal(controller.services.has(first), false);
  });

  it('refuses a key that is not an identifier', () => {
    const disk = createServiceToken<string>('disk');
    for (const key of ['', 'has space', 'a'.repeat(300)]) {
      assert.throws(
        () => disk.named(key),
        (error: unknown) => ServiceErrors.is(error, 'invalid_token_key'),
      );
    }
  });
});

describe('live service tokens', () => {
  it('a live family makes live members', () => {
    const queue = createServiceToken<object>('queue', { live: true });
    assert.equal(queue.live, true);
    assert.equal(queue.named('mail').live, true);
    assert.equal(createServiceToken<object>('plain').live, false);
  });

  it('refuses malformed options', () => {
    for (const options of [null, { live: 'yes' }]) {
      assert.throws(
        () => createServiceToken('queue', options as never),
        (error: unknown) => ServiceErrors.is(error, 'invalid_token_option'),
      );
    }
  });
});

describe('isServiceToken', () => {
  it('recognises families and members, nothing else', () => {
    const disk = createServiceToken<string>('disk');
    assert.ok(isServiceToken(disk));
    assert.ok(isServiceToken(disk.named('media')));
    assert.equal(isServiceToken({ name: 'disk' }), false);
    assert.equal(isServiceToken('disk'), false);
    assert.equal(isServiceToken(null), false);
  });
});
