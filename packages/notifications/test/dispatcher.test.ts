/**
 * Dispatcher tests: `notify` fans out to every configured channel or to a
 * requested subset in order, keeps attempting every channel when one fails,
 * aggregates failures (including a synchronous throw) into a value-free
 * `NotificationError`, and rejects an unknown channel name before any channel
 * runs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryNotificationChannel } from '../src/channels.js';
import { NotificationError, type NotificationChannel } from '../src/contract.js';
import { NotificationDispatcher } from '../src/dispatcher.js';
import { failingChannel, MESSAGE } from './fixtures.js';

describe('NotificationDispatcher', () => {
  it('delivers to every configured channel', async () => {
    const a = new InMemoryNotificationChannel();
    const b = new InMemoryNotificationChannel();
    await new NotificationDispatcher({ a, b }).notify(MESSAGE);
    assert.deepEqual(a.messages(), [MESSAGE]);
    assert.deepEqual(b.messages(), [MESSAGE]);
  });

  it('resolves without channels', async () => {
    await new NotificationDispatcher({}).notify(MESSAGE);
  });

  it('delivers to a requested subset, in the requested order', async () => {
    const order: string[] = [];
    const record = (name: string): NotificationChannel => ({
      async send() {
        order.push(name);
      },
    });
    const dispatcher = new NotificationDispatcher({
      a: record('a'),
      b: record('b'),
      c: record('c'),
    });
    await dispatcher.notify(MESSAGE, { channels: ['c', 'a'] });
    assert.deepEqual(order, ['c', 'a']);
  });

  it('aggregates per-channel failures into a value-free error and still sends to all', async () => {
    const delivered = new InMemoryNotificationChannel();
    const dispatcher = new NotificationDispatcher({ failing: failingChannel, delivered });
    await assert.rejects(dispatcher.notify(MESSAGE), (error: unknown) => {
      assert.ok(
        error instanceof NotificationError,
        `expected NotificationError, got ${String(error)}`,
      );
      assert.equal(error.code, 'delivery_failed');
      assert.deepEqual(error.channels, ['failing'], 'failed channels in configuration order');
      assert.ok(!error.message.includes('SECRET_BACKEND_CREDENTIAL'), 'value-free');
      assert.ok(!error.message.includes('ada@example.com'), 'no recipient in the error');
      return true;
    });
    assert.deepEqual(delivered.messages(), [MESSAGE], 'the healthy channel still received it');
  });

  it('aggregates a synchronous channel throw like a rejection', async () => {
    const syncThrow: NotificationChannel = {
      send() {
        throw new Error('sync boom');
      },
    };
    await assert.rejects(
      new NotificationDispatcher({ syncThrow }).notify(MESSAGE),
      (error: unknown) => {
        assert.ok(error instanceof NotificationError);
        assert.equal(error.code, 'delivery_failed');
        assert.deepEqual(error.channels, ['syncThrow']);
        assert.ok(!error.message.includes('sync boom'));
        return true;
      },
    );
  });

  it('rejects an unknown channel name before any channel runs, without echoing it', async () => {
    const memory = new InMemoryNotificationChannel();
    await assert.rejects(
      new NotificationDispatcher({ memory }).notify(MESSAGE, { channels: ['memory', 'missing'] }),
      (error: unknown) => {
        assert.ok(error instanceof NotificationError);
        assert.equal(error.code, 'unknown_channel');
        assert.deepEqual(error.channels, []);
        assert.ok(!error.message.includes('missing'));
        return true;
      },
    );
    assert.deepEqual(memory.messages(), [], 'no channel was attempted');
  });
});
