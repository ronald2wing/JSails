/**
 * `defineNotification` tests: the channel list follows the builders, `via`
 * narrows it per notifiable, a builder receives props and notifiable, and a
 * malformed definition is refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationError } from '../src/contract.js';
import { defineNotification } from '../src/define-notification.js';

const ADA = { id: 1, email: 'ada@example.com' };

describe('defineNotification', () => {
  it('lists the channels it builds, in definition order', () => {
    const paid = defineNotification<{ readonly amount: number }>('invoice.paid', {
      channels: {
        mail: (props) => ({ subject: `Paid ${props.amount}`, text: 'thanks' }),
        database: (props, notifiable) => ({ amount: props.amount, for: notifiable.id }),
        broadcast: undefined,
      },
    });
    assert.equal(paid.name, 'invoice.paid');
    assert.deepEqual(paid.channelNames, ['mail', 'database']);
    assert.deepEqual(paid.via(ADA, { amount: 5 }), ['mail', 'database']);
    assert.deepEqual(paid.build('database', { amount: 5 }, ADA), { amount: 5, for: 1 });
    assert.ok(Object.isFrozen(paid));
  });

  it('narrows channels per notifiable with via', () => {
    const digest = defineNotification<object>('digest', {
      channels: { mail: () => ({ subject: 's' }), database: () => ({}) },
      via: (notifiable) => (notifiable.email === undefined ? ['database'] : ['mail', 'database']),
    });
    assert.deepEqual(digest.via({ id: 'x' }, {}), ['database']);
    assert.deepEqual(digest.via(ADA, {}), ['mail', 'database']);
  });

  it('refuses a via result that is not a list of names', () => {
    const bad = defineNotification<object>('bad', {
      channels: { database: () => ({}) },
      via: () => 'database' as never,
    });
    assert.throws(
      () => bad.via(ADA, {}),
      (error: unknown) =>
        error instanceof NotificationError && error.code === 'unsupported_channel',
    );
  });

  it('refuses to build for a channel it does not support', () => {
    const only = defineNotification<object>('only', { channels: { database: () => ({}) } });
    assert.throws(
      () => only.build('mail', {}, ADA),
      (error: unknown) =>
        error instanceof NotificationError && error.code === 'unsupported_channel',
    );
  });

  it('rejects a malformed definition', () => {
    const channels = { database: () => ({}) };
    assert.throws(() => defineNotification('', { channels }), TypeError);
    assert.throws(() => defineNotification('with space', { channels }), TypeError);
    assert.throws(() => defineNotification('ok', null as never), TypeError);
    assert.throws(() => defineNotification('ok', { channels: [] as never }), TypeError);
    assert.throws(() => defineNotification('ok', { channels: {} }), TypeError);
    assert.throws(() => defineNotification('ok', { channels: { mail: 'x' } as never }), TypeError);
    assert.throws(() => defineNotification('ok', { channels, via: 'all' as never }), TypeError);
  });
});
