---
title: Notifications
order: 47
section: Reference
---

# Notifications

`@jsails/notifications` sends one event to a user through several channels at
once: mail, a database inbox with read/unread state, realtime broadcast, or any
channel you write. Each channel either delivers or fails on its own, and the
caller gets one error naming the channels that failed.

```sh
npm install @jsails/notifications
```

## The plugin

```ts
// jsails.app.ts
import { mailPlugin } from '@jsails/mail';
import { createDatabaseNotificationStore, notificationsPlugin } from '@jsails/notifications';
import { broadcastPlugin } from 'jsails/broadcast';
import dataSource from './jsails.database.js';

export default defineApp({
  plugins: {
    use: [
      mailPlugin({}),
      broadcastPlugin(broadcastOptions), // see Live for authentication and channel rules
      notificationsPlugin({
        mail: true,
        database: createDatabaseNotificationStore({ getDataSource: () => dataSource }),
        broadcast: true,
      }),
    ],
  },
});
```

Each option adds a channel of the same name:

- `mail: true` adds `mail`, which sends through the mail plugin's mailer. The
  mail plugin must come earlier in `plugins.use`; assembly fails otherwise.
  `mail: 'queue'` queues each message instead; see [Retries](#retries).
- `database: store` adds `database`, which writes an unread record per
  notification. The store is provided under `notificationStoreToken`, and the
  plugin declares the `jsails_notifications` table as its schema, so
  `jsails db:push` creates it. An app that builds its own data source adds
  `notificationEntities` to its entity list.
- `broadcast: true` adds `broadcast`, which publishes through the
  `jsails/broadcast` service of the same application, looked up when a
  notification is sent. Pass `broadcast: { publisher }` to publish through
  something else; see [Custom channels](#custom-channels).
- `channels: { name: channel }` adds your own channels.

The plugin connects nothing at startup. `jsails/broadcast` (and Socket.IO) is
loaded on the first broadcast delivery, and the database store opens its data
source on first use.

## Defining a notification

`defineNotification(name, { channels, via? })` maps each channel the
notification supports to a function building that channel's payload:

```ts
// notifications/invoice-paid.ts
import { defineNotification } from '@jsails/notifications';
import { InvoicePaidMail } from '../mail/invoice-paid.js'; // a defineMail template

export const InvoicePaid = defineNotification<{ readonly invoice: Invoice }>('invoice.paid', {
  channels: {
    mail: ({ invoice }) => InvoicePaidMail.render({ invoice }),
    database: ({ invoice }) => ({ invoiceId: invoice.id, total: invoice.total }),
    broadcast: ({ invoice }) => ({ invoiceId: invoice.id }),
  },
  via: (user) => (user.email === undefined ? ['database', 'broadcast'] : ['mail', 'database', 'broadcast']),
});
```

The built-in channels take:

| Channel     | Payload                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `mail`      | A mail message. `to` may be left out; it then goes to the notifiable's `email`. A `defineMail` template's `render(props)` fits as is. |
| `database`  | A JSON object of at most 64 KiB, stored as the record's `data`.                                     |
| `broadcast` | Any JSON value, published as the event's `data`.                                                    |

`via` picks the channels per recipient. Without it, every channel the
notification builds a payload for is used.

## Sending

```ts
const notifications = services.get(notificationsToken);

await notifications.send(
  { id: user.id, email: user.email },
  InvoicePaid,
  { invoice },
);
```

`send(notifiables, notification, props, { channels? })` takes one notifiable or
an array of up to 1000. A notifiable is `{ id, email?, broadcastChannel? }`:
`id` (a string or a safe integer) keys database records and the default
broadcast channel. Before anything is delivered, every selected channel is
checked for every notifiable. A channel that is not configured fails with
`unknown_channel`, and one the notification builds no payload for fails with
`unsupported_channel`, so a typo never half-delivers a batch.

Then each channel delivers to each notifiable. A payload builder runs inside
its own channel's attempt, so a throwing builder fails only that channel. When
anything fails, `send` rejects with `NotificationError('delivery_failed')`
after every attempt has settled; its `channels` lists the failed channel names,
and its message never repeats an address, payload, or backend error. A channel
named twice, by `via` or by `channels`, delivers once.

Each channel runs at most `concurrency` attempts at a time (default 10), so a
batch to 1000 recipients never opens 1000 SMTP sends or database writes at
once. An attempt has `channelTimeoutMs` (default 30000) to finish, counted from
when it starts rather than from when the batch was queued, so an attempt still
waiting its turn is never reported as timed out. A timed-out attempt is no
longer awaited but is not cancelled; its message may still be delivered.

`notify(message, { channels? })` remains for a plain `{ to, subject, text }`
message. Without `channels`, it uses every configured channel except
`database` and `broadcast`, which address recipients by id rather than by
`to`, so adding them leaves existing `notify` calls delivering as before. Named
explicitly, the database channel stores the message under the type `message`
keyed by `to`, and the broadcast channel publishes it on `to`'s channel.

Every application that assembles the plugin gets its own channels and
dispatcher, so one `notificationsPlugin(...)` value shared by a web and a worker
runtime in one process publishes through each runtime's own broadcast service.

## The database inbox

The store behind the `database` channel is the inbox API:

```ts
const inbox = services.get(notificationStoreToken);
const key = String(user.id);

const unread = await inbox.list(key, { unread: true, limit: 20 });
const count = await inbox.unreadCount(key);
await inbox.markRead(key, notificationId);
await inbox.markUnread(key, notificationId);
await inbox.markAllRead(key);
await inbox.delete(key, notificationId);
```

Every call takes the notifiable's key, and an id only matches that
notifiable's records. A handler that passes the signed-in user's key can
therefore never read or mark another user's notification, even with a guessed
id. Records come newest first: `{ id, notifiable, type, data, readAt,
createdAt }`, where `type` is the notification's name and `readAt` is `null`
while unread.

`createDatabaseNotificationStore({ dataSource | getDataSource, now? })` works
through TypeORM repositories and never creates tables. If the table is missing,
it fails with `missing_table` until `db:push` has run. `InMemoryNotificationStore`
has the same API for tests.

## Broadcast

The broadcast channel publishes the event `notification` with
`{ type, data }` on the notifiable's `broadcastChannel`, or by default on
`notifications.<id>`. `broadcast: { channelFor, event }` changes either.
Publishing does not authorize anyone: your broadcast `authorizeChannel` decides
who may subscribe to `notifications.<id>`, and it should allow only that user.
Broadcast is ephemeral, so a client that is not connected misses the event.
Pair it with the database channel when the notification must be seen later.

If no broadcast service is registered, the broadcast attempt fails with
`missing_broadcast` while the other channels still deliver. Publishing before
the server starts fails the same way.

## Custom channels

A channel implements `send(message)` for plain messages, and optionally
`deliver({ notification, notifiable, payload })` for defined notifications:

```ts
import type { NotificationChannel } from '@jsails/notifications';

const sms: NotificationChannel = {
  async send(message) {
    await smsClient.send(message.to, message.text);
  },
};

notificationsPlugin({ channels: { sms } });

defineNotification<{ readonly phone: string; readonly code: string }>('login.code', {
  channels: {
    sms: ({ phone, code }) => ({ to: phone, subject: 'Code', text: `Your code: ${code}` }),
  },
});
```

A channel without `deliver` receives the payload through `send`, so the payload
must be a `{ to, subject, text }` message. To publish through a realtime
transport other than `jsails/broadcast`, give the broadcast channel any object
with `publish(channel, event, data)`:
`notificationsPlugin({ broadcast: { publisher: pusher } })`, or build a
`BroadcastNotificationChannel` yourself.

## Retries

Delivery happens in the calling process, with no retry. When mail must survive
a slow or failing server, use `mail: 'queue'` instead of `mail: true`: the
`mail` channel then validates each message and dispatches it as the mail
plugin's `mail.send` job, and a worker sends it with the queue's retries. This
needs the jobs plugin and `mailSendJob` registered in the worker; see
[Mail](/docs/mail#queued-delivery). A failed dispatch (for example, no jobs
runtime) fails the `mail` channel like a failed send.
