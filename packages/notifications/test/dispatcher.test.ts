/**
 * Dispatcher tests: `notify` fans out to every configured channel or to a
 * requested subset in order, keeps attempting every channel when one fails,
 * aggregates failures (including a synchronous throw) into a value-free
 * `NotificationError`, and rejects an unknown channel name before any channel
 * runs. `send` delivers a defined notification per notifiable with the same
 * guarantees, validating every selection before the first delivery.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryNotificationChannel } from '../src/channels.js';
import {
  MAX_NOTIFIABLES,
  NotificationError,
  type NotificationChannel,
  type NotificationMessage,
} from '../src/contract.js';
import { DatabaseNotificationChannel } from '../src/database-channel.js';
import { defineNotification } from '../src/define-notification.js';
import { NotificationDispatcher } from '../src/dispatcher.js';
import { InMemoryNotificationStore } from '../src/store.js';
import { code, failingChannel, MESSAGE } from './fixtures.js';

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

  it('counts a hung channel as failed after the timeout and still delivers the others', async () => {
    const fast = new InMemoryNotificationChannel();
    const hung: NotificationChannel = { send: () => new Promise<void>(() => {}) };
    const dispatcher = new NotificationDispatcher({ hung, fast }, { channelTimeoutMs: 20 });
    const started = Date.now();
    await assert.rejects(
      dispatcher.notify(MESSAGE),
      (error: unknown) =>
        error instanceof NotificationError &&
        error.code === 'delivery_failed' &&
        error.channels.length === 1 &&
        error.channels[0] === 'hung',
    );
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(fast.messages(), [MESSAGE]);
  });

  it('rejects a non-positive channel timeout', () => {
    assert.throws(() => new NotificationDispatcher({}, { channelTimeoutMs: 0 }), TypeError);
  });

  it('rejects a malformed concurrency or opt-in list', () => {
    assert.throws(() => new NotificationDispatcher({}, { concurrency: 0 }), TypeError);
    assert.throws(() => new NotificationDispatcher({}, { concurrency: 1.5 }), TypeError);
    assert.throws(
      () => new NotificationDispatcher({}, { optInChannels: 'database' as never }),
      TypeError,
    );
  });

  it('skips opt-in channels unless notify names them', async () => {
    const mail = new InMemoryNotificationChannel();
    const inbox = new InMemoryNotificationChannel();
    const dispatcher = new NotificationDispatcher({ mail, inbox }, { optInChannels: ['inbox'] });
    await dispatcher.notify(MESSAGE);
    assert.deepEqual(mail.messages(), [MESSAGE]);
    assert.deepEqual(inbox.messages(), []);
    await dispatcher.notify(MESSAGE, { channels: ['inbox'] });
    assert.deepEqual(inbox.messages(), [MESSAGE]);
  });

  it('delivers once to a channel named twice', async () => {
    const memory = new InMemoryNotificationChannel();
    await new NotificationDispatcher({ memory }).notify(MESSAGE, {
      channels: ['memory', 'memory'],
    });
    assert.deepEqual(memory.messages(), [MESSAGE]);
  });
});

describe('NotificationDispatcher.send', () => {
  const ADA = { id: 1, email: 'ada@example.com' };
  const GRACE = { id: 2, email: 'grace@example.com' };

  const paid = defineNotification<{ readonly amount: number }>('invoice.paid', {
    channels: {
      mail: (props) => ({ subject: `Paid ${props.amount}`, text: 'thanks' }),
      database: (props) => ({ amount: props.amount }),
    },
  });

  it('delivers a defined notification to every notifiable through its channels', async () => {
    const mail = new InMemoryNotificationChannel();
    const store = new InMemoryNotificationStore();
    const dispatcher = new NotificationDispatcher({
      mail,
      database: new DatabaseNotificationChannel({ store }),
    });
    await dispatcher.send([ADA, GRACE], paid, { amount: 5 });
    assert.deepEqual(
      mail.deliveries().map((delivery) => [delivery.notification, delivery.notifiable.id]),
      [
        ['invoice.paid', 1],
        ['invoice.paid', 2],
      ],
    );
    assert.deepEqual(mail.deliveries()[0]?.payload, { subject: 'Paid 5', text: 'thanks' });
    assert.deepEqual((await store.list('2'))[0]?.data, { amount: 5 });
  });

  it('narrows to the requested channels', async () => {
    const mail = new InMemoryNotificationChannel();
    const database = new InMemoryNotificationChannel();
    await new NotificationDispatcher({ mail, database }).send(
      ADA,
      paid,
      { amount: 1 },
      {
        channels: ['database'],
      },
    );
    assert.equal(mail.deliveries().length, 0);
    assert.equal(database.deliveries().length, 1);
  });

  it('checks every channel for every notifiable before delivering anything', async () => {
    const mail = new InMemoryNotificationChannel();
    const database = new InMemoryNotificationChannel();
    const dispatcher = new NotificationDispatcher({ mail, database });
    const partial = defineNotification<object>('partial', {
      channels: { mail: () => ({ subject: 's' }), sms: () => ({}) },
      via: (notifiable) => (notifiable.id === 2 ? ['mail', 'sms'] : ['mail']),
    });
    await assert.rejects(dispatcher.send([ADA, GRACE], partial, {}), code('unknown_channel'));
    await assert.rejects(
      dispatcher.send(ADA, paid, { amount: 1 }, { channels: ['mail', 'broadcast'] }),
      code('unsupported_channel'),
    );
    await assert.rejects(
      dispatcher.send({ id: '' }, paid, { amount: 1 }),
      code('invalid_notifiable'),
    );
    assert.equal(mail.deliveries().length, 0, 'nothing was delivered');
  });

  it('fails only the channel whose builder or delivery throws', async () => {
    const mail = new InMemoryNotificationChannel();
    const database = new InMemoryNotificationChannel();
    const throwing = defineNotification<object>('throwing', {
      channels: {
        mail: () => ({ subject: 's' }),
        database: () => {
          throw new Error('SECRET_PAYLOAD');
        },
      },
    });
    await assert.rejects(
      new NotificationDispatcher({ mail, database }).send(ADA, throwing, {}),
      (error: unknown) =>
        error instanceof NotificationError &&
        error.code === 'delivery_failed' &&
        error.channels.join() === 'database' &&
        !error.message.includes('SECRET_PAYLOAD'),
    );
    assert.equal(mail.deliveries().length, 1);
  });

  it('hands a channel without deliver a message payload through send', async () => {
    const sent: NotificationMessage[] = [];
    const sms: NotificationChannel = {
      async send(message) {
        sent.push(message);
      },
    };
    const text = defineNotification<{ readonly code: string }>('otp', {
      channels: {
        sms: (props, notifiable) => ({
          to: String(notifiable.id),
          subject: 'Code',
          text: props.code,
        }),
      },
    });
    const dispatcher = new NotificationDispatcher({ sms });
    await dispatcher.send(ADA, text, { code: '1234' });
    assert.deepEqual(sent, [{ to: '1', subject: 'Code', text: '1234' }]);

    const bad = defineNotification<object>('bad', { channels: { sms: () => ({ subject: 'x' }) } });
    await assert.rejects(dispatcher.send(ADA, bad, {}), code('delivery_failed'));
  });

  it('delivers once per notifiable when a channel is selected twice', async () => {
    const mail = new InMemoryNotificationChannel();
    const twice = defineNotification<object>('twice', {
      channels: { mail: () => ({ subject: 's' }) },
      via: () => ['mail', 'mail'],
    });
    const dispatcher = new NotificationDispatcher({ mail });
    await dispatcher.send([ADA, GRACE], twice, {});
    await dispatcher.send(ADA, paid, { amount: 1 }, { channels: ['mail', 'mail'] });
    assert.equal(mail.deliveries().length, 3);
  });

  it('bounds concurrency and starts each timer only when its attempt starts', async () => {
    let inFlight = 0;
    let peak = 0;
    const delivered: unknown[] = [];
    const slow: NotificationChannel = {
      send: async () => undefined,
      async deliver(delivery) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        delivered.push(delivery.notifiable.id);
      },
    };
    const notice = defineNotification<object>('notice', {
      channels: { slow: () => ({ text: 'x' }) },
    });
    // Eight 40 ms attempts two at a time take ~160 ms, well past the 100 ms
    // timeout: a timer started at enqueue would fail the later ones.
    const dispatcher = new NotificationDispatcher(
      { slow },
      { concurrency: 2, channelTimeoutMs: 100 },
    );
    const notifiables = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));
    await dispatcher.send(notifiables, notice, {});
    assert.equal(peak, 2);
    assert.equal(delivered.length, 8);
  });

  it('caps the number of notifiables', async () => {
    const many = Array.from({ length: MAX_NOTIFIABLES + 1 }, (_, id) => ({ id }));
    await assert.rejects(
      new NotificationDispatcher({ mail: new InMemoryNotificationChannel() }).send(many, paid, {
        amount: 1,
      }),
      code('too_large'),
    );
  });
});
