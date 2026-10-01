/**
 * Audit regressions for notifications (CNT-01): each test states the correct
 * behaviour for one audited defect. Those that fail today are listed, with
 * the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditCase, createEmptyDataSource } from 'jsails/testing';

import { NotificationError, type NotificationChannel } from '../src/contract.js';
import { defineNotification } from '../src/define-notification.js';
import { NotificationDispatcher } from '../src/dispatcher.js';
import { JsailsNotification, notificationEntities } from '../src/entities.js';
import { MESSAGE } from './fixtures.js';

test(
  ...auditCase(
    'notifications/notifiable-index',
    'the notifications table indexes the notifiable column every read filters on',
  ),
  async () => {
    const dataSource = await createEmptyDataSource([...notificationEntities]);
    try {
      const leading = dataSource
        .getMetadata(JsailsNotification)
        .indices.map((index) => index.columns[0]?.propertyName);
      assert.ok(
        leading.includes('notifiable'),
        'no index leads with notifiable, so list, unreadCount and markAllRead scan the table',
      );
    } finally {
      await dataSource.destroy();
    }
  },
);

test(
  ...auditCase(
    'notifications/timeout-cancels-attempt',
    'a channel attempt that times out is told to stop through an AbortSignal',
  ),
  async () => {
    let seen: AbortSignal | undefined;
    const hanging: NotificationChannel = {
      send(...args: unknown[]) {
        const context = args[1] as { signal?: AbortSignal } | undefined;
        seen = context?.signal;
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          seen?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
    const dispatcher = new NotificationDispatcher({ hanging }, { channelTimeoutMs: 20 });
    await assert.rejects(dispatcher.notify(MESSAGE), NotificationError);
    assert.ok(
      seen !== undefined,
      'the channel received no AbortSignal, so a timed-out send runs on',
    );
    assert.equal(seen.aborted, true, 'the timed-out attempt was not aborted');
  },
);

test(
  ...auditCase(
    'notifications/concurrency-bound',
    'a timed-out attempt still counts against the channel concurrency until it ends',
  ),
  async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: NotificationChannel = {
      async send() {
        throw new Error('unused');
      },
      async deliver() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 120));
        inFlight -= 1;
      },
    };
    const ping = defineNotification<object>('audit.ping', { channels: { slow: () => ({}) } });
    const dispatcher = new NotificationDispatcher(
      { slow },
      { channelTimeoutMs: 20, concurrency: 1 },
    );
    await assert.rejects(dispatcher.send([{ id: 1 }, { id: 2 }, { id: 3 }], ping, {}));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(peak, 1, `concurrency 1 let ${peak} attempts run at once`);
  },
);

test(
  ...auditCase(
    'notifications/failure-cause',
    'a failed delivery keeps the channel error as its cause',
  ),
  async () => {
    const original = new Error('smtp 421');
    const failing: NotificationChannel = {
      async send() {
        throw original;
      },
    };
    await assert.rejects(new NotificationDispatcher({ failing }).notify(MESSAGE), (error) => {
      assert.ok(error instanceof NotificationError);
      const causes =
        error.cause instanceof AggregateError ? error.cause.errors : [error.cause].filter(Boolean);
      assert.ok(
        causes.includes(original),
        'the channel error was discarded, so the failure cannot be diagnosed',
      );
      return true;
    });
  },
);
