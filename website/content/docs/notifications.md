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
// jsails.app.js
import { mailPlugin } from '@jsails/mail';
import { notificationsPlugin, notificationStoreToken } from '@jsails/notifications';
import { broadcastPlugin } from 'jsails/broadcast';
import { inboxPlugin } from './app/inbox.js';
import dataSource from './jsails.database.js';

export default {
  plugins: {
    use: [
      mailPlugin({}),
      broadcastPlugin(broadcastOptions), // see Live for authentication and channel rules
      inboxPlugin({ getDataSource: () => dataSource }), // see The database inbox
      notificationsPlugin({
        mail: true,
        database: notificationStoreToken,
        broadcast: true,
      }),
    ],
  },
};
```

Each option adds a channel of the same name:

- `mail: true` adds `mail`, which sends through the mail plugin's mailer. The
  plugin then requires `mailToken`, so assembly fails without the mail plugin.
  `mail: 'queue'` queues each message instead; see [Retries](#retries).
- `database: notificationStoreToken` adds `database`, which writes an unread
  record per notification to the store another plugin provides under that
  token (or a keyed member, `notificationStoreToken.named('inbox')`). The
  plugin requires that service; see [The database inbox](#the-database-inbox).
- `broadcast: true` adds `broadcast`, which publishes through the
  `jsails/broadcast` service of the same application, looked up when a
  notification is sent. Pass `broadcast: { publisher }` to publish through
  something else; see [Custom channels](#custom-channels).
- `channels: { name: channel }` adds your own channels.

Options that add no channel at all, no options included, fail with
`config.invalid_options`, so an app that forgot `mail: true` fails at config
load instead of dropping every message. Options are data and functions,
checked when the config loads: a store, a
publisher object or a channel without `send` fails with
`config.invalid_options`, naming the option and never its value, and so does a
channel named `mail`, `database` or `broadcast` beside the option that
installs it. A channel is read as its `send` and optional `deliver`, bound to
the object you passed, so a class instance keeps its private state.

The plugin connects nothing at startup, and importing `@jsails/notifications`
loads no TypeORM, Socket.IO or BullMQ: the broadcast and jobs services are
optional services it reads when a notification is sent.

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
keyed by `to`, and the broadcast channel publishes it on `to`'s channel. A
`notify` that selects no channel (only `database` and `broadcast` configured
and none named, or `channels: []`) rejects with `no_channel`, so it never
resolves without having delivered. `send` is different: `via` returning no
channel is how a recipient opts out, and it resolves.

Every application that assembles the plugin gets its own channels and
dispatcher, so one `notificationsPlugin(...)` instance shared by a web and a
worker runtime in one process publishes through each runtime's own broadcast
service.

## The database inbox

The database store and its `jsails_notifications` table live on the
`@jsails/notifications/database` subpath, so the plugin's own entry stays free
of TypeORM. The app owns the table and the plugin that provides the store: it
adds `notificationEntities` to its data source, so `jsails db:push` creates
the table, and provides the store under `notificationStoreToken`.

```ts
// app/inbox.ts
import { definePlugin, fn } from 'jsails/kernel';
import { notificationStoreToken } from '@jsails/notifications';
import {
  createDatabaseNotificationStore,
  type NotificationDataSource,
} from '@jsails/notifications/database';
import { z } from 'zod';

export const inboxPlugin = definePlugin({
  name: 'inbox',
  options: z.object({ getDataSource: fn<() => NotificationDataSource>() }).strict(),
  provides: [notificationStoreToken],
  setup({ options, services }) {
    services.provide(
      notificationStoreToken,
      createDatabaseNotificationStore({ getDataSource: options.getDataSource }),
    );
  },
});
```

The config passes the thunk (`inboxPlugin({ getDataSource: () => dataSource })`,
with `dataSource` from `jsails.database.js`), so nothing connects until the
first inbox call.

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
transport other than `jsails/broadcast`, give the broadcast channel a function
that returns (or resolves to) any object with `publish(channel, event, data)`;
it is called at delivery time:
`notificationsPlugin({ broadcast: { publisher: () => pusher } })`, or build a
`BroadcastNotificationChannel` yourself.

## Retries

Delivery happens in the calling process, with no retry. When mail must survive
a slow or failing server, use `mail: 'queue'` instead of `mail: true`: the
`mail` channel then validates each message and dispatches it as the mail
plugin's `mail.send` job, and a worker sends it with the queue's retries. This
needs the jobs plugin and `mailSendJob` registered in the worker; see
[Mail](/docs/mail#queued-delivery). A failed dispatch (for example, no jobs
runtime) fails the `mail` channel like a failed send.
