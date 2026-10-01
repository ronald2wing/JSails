---
title: Mail
order: 46
section: Reference
---

# Mail

`@jsails/mail` sends mail through a transport you choose: SMTP, an in-memory
outbox, or a callback. It renders templates written as Preact components, can
hand delivery to a background job, and in development serves a preview of
every template and of everything the app has sent.

```sh
npm install @jsails/mail
```

## The plugin

```ts
// jsails.app.ts
import { mailPlugin } from '@jsails/mail';
import { WelcomeMail } from './mail/welcome.js';

export default defineApp({
  plugins: {
    use: [
      // SMTP comes from MAIL_URL; without it, development captures mail in memory.
      mailPlugin({
        allowMemory: process.env.NODE_ENV === 'development',
        previews: [WelcomeMail],
      }),
    ],
  },
});
```

The plugin provides the mailer under `mailToken`, and the `Mail` facade reaches
it from any request, job, or setup. The transport is chosen on the first send,
in this order:

1. an explicit `transport`, used as given and never closed by the plugin;
2. the `smtp` option (`url`, or `host`/`port`/`user`/`pass`);
3. `MAIL_URL`, then `SMTP_URL`, from the environment;
4. an in-memory transport, only when `allowMemory: true`;
5. otherwise the send fails with `MailError('missing_transport')`. A production
   app with no transport configured refuses mail instead of dropping it.

Nothing connects when the app starts: nodemailer and the SMTP connection are
created on the first send.

## Messages

```ts
import { Mail } from '@jsails/mail';

await Mail.send({
  to: [{ name: 'Ada', address: 'ada@example.com' }],
  subject: 'Your export is ready',
  text: 'Download it from your dashboard.',
  attachments: [{ filename: 'export.csv', content: csv, contentType: 'text/csv' }],
});
```

A message has one recipient or an array, optional `cc`, `bcc`, `replyTo`, and
`from`, a `text` and/or `html` body, and in-memory attachments. An address is a
bare `user@example.com` or `{ name, address }`. A display name is never parsed
out of a string, so `"App" <no-reply@example.com>` written as a string is
refused. One message carries at most 100 recipients, and every header value is
checked for line breaks. Errors are `MailError`s with a stable `code` and never
repeat an address, subject, or credential.

## Templates

`defineMail(name, { subject, render, text?, preview? })` defines a template.
`render` returns a Preact element tree. The HTML part is rendered with
`jsails/render-to-string`, so Preact escapes every prop, and a template can
only emit raw HTML through `dangerouslySetInnerHTML`.

```tsx
// mail/welcome.tsx
import { defineMail } from '@jsails/mail';

interface WelcomeProps {
  readonly name: string;
  readonly dashboardUrl: string;
}

export const WelcomeMail = defineMail<WelcomeProps>('welcome', {
  subject: (props) => `Welcome, ${props.name}`,
  render: (props) => (
    <div>
      <h1>Hello {props.name}</h1>
      <p>
        Start at <a href={props.dashboardUrl}>your dashboard</a>.
      </p>
    </div>
  ),
  preview: { name: 'Ada', dashboardUrl: 'https://example.com/dashboard' },
});
```

```ts
await Mail.send(WelcomeMail.message({ to: user.email }, { name: user.name, dashboardUrl }));
```

`message(envelope, props)` returns a `Mailable`: an ordinary message with
`subject`, `html`, and `text` filled in, plus `mail` naming the template. It
sends, queues, and validates like any other message. `render(props)` returns
only `{ subject, html, text }`, which is handy as a notification's mail
payload.

Every message from a template has a text part. Give `text(props)` to write it
yourself. Otherwise it is derived from the HTML: block elements and `<br>`
become line breaks, list items get a `- ` marker, a link keeps its URL in
parentheses, and `<head>`, `<style>`, and `<script>` content is dropped. A
subject that renders empty or with a line break fails with
`MailError('invalid_subject')`. When `render` returns a whole `<html>`
document, the HTML part starts with `<!DOCTYPE html>`.

## Queued delivery

`Mail.queue(message, options?)` sends from a background worker instead of
blocking the request. The message is validated first, so a bad address fails
where it was written and nothing is dispatched. Then the `mail.send` job is
dispatched through the jobs service of the same application (see
[Jobs](/docs/jobs)). Attachments travel as base64, and an encoded message may
be at most 5 MiB (`MailError('too_large')`); link to large files instead of
attaching them. `options` are the jobs runtime's dispatch options (`delay`,
`attempts`, `jobId`, ...).

```ts
await Mail.queue(WelcomeMail.message({ to: user.email }, props), { delay: 60_000 });
```

Register the job with your other jobs. A `jobs/` module only has to re-export
it:

```ts
// jobs/mail-send.job.ts
export { mailSendJob as default } from '@jsails/mail';
```

The worker sends through its own application's mail service, so run
`mailPlugin` in the worker process too, or bind a mailer explicitly with
`createMailSendJob({ mailer })`. A message the validator rejects is not
retried; any other failure is retried under the queue's retry policy.

Without a jobs runtime, `Mail.queue` fails with `MailError('missing_jobs')`.
Mail never falls back to sending inline. `queueMail(jobs, message, options?)`
does the same with a jobs service you pass in, and `mailToken`'s service from
the plugin has the same `queue` method. `jsails/jobs` is loaded on the first
queued message, so an app that never queues mail never loads the queue client.

Test a queued send with the jobs recorder from `jsails/testing`:

```ts
import { createFakeJobs } from 'jsails/testing';
import { createJobRegistry } from 'jsails/jobs';
import { MAIL_SEND_JOB, mailSendJob, queueMail } from '@jsails/mail';

const jobs = createFakeJobs({ registry: createJobRegistry({ [MAIL_SEND_JOB]: mailSendJob }) });
await queueMail(jobs, message);
jobs.assertDispatched(MAIL_SEND_JOB);
```

## Development preview

When `NODE_ENV` is exactly `development`, the plugin mounts a preview at
`/_jsails/mail`:

- the index lists every template passed as `previews` and the in-memory outbox;
- `/_jsails/mail/templates/<name>` renders a template with its `preview` props
  (`?part=text` shows the text part);
- `/_jsails/mail/outbox/<n>` shows a captured message.

The outbox is the in-memory transport's capture, so it fills when the app runs
with `allowMemory: true` and no SMTP configuration (or with an explicit
`InMemoryMailTransport`). Rendered mail is served under a `sandbox`
Content-Security-Policy, so its HTML runs in an opaque origin with no script
and no access to the app's cookies. The routes answer only a request whose
socket peer is this machine (`127.0.0.0/8` or `::1`) and that carries no
`Forwarded`, `X-Forwarded-For`, or `X-Real-IP` header; anything else gets a
404, so a development server listening on every interface does not expose the
outbox's reset links and sign-in codes to its network. In any other
environment the plugin registers no route, and the paths fall through to the
app's 404.

## Transports

`SmtpMailTransport` pools connections and bounds every phase by default:
`pool: true`, `maxConnections: 5`, `connectionTimeoutMs: 10000`,
`greetingTimeoutMs: 10000`, and `socketTimeoutMs: 30000`. An unreachable or
slow server therefore fails a send in seconds instead of holding a request for
minutes. With a `url`, the settings travel as URL query parameters, and a
parameter already in the URL (`smtp://host?pool=false`) wins.

A connection that does not start in TLS must upgrade with STARTTLS
(`requireTLS: true`) unless the host is loopback, so credentials and message
bodies never cross the network in plain text because a server or a
man-in-the-middle omitted the STARTTLS offer. A connection starts in TLS with
`secure: true`, an `smtps://` URL, or port 465. Pass `requireTLS: false` (or
`?requireTLS=false` in the URL) only for a trusted relay that cannot offer
TLS. The transport also forbids nodemailer from reading a local file or
fetching a URL for a message's content or attachments, whatever the options
or URL say, so message data can never pull in server files.

`InMemoryMailTransport` keeps sent messages for `messages()`, and
`CallbackMailTransport` hands each validated message to your function. Every
transport validates through the same rules, so a bad message fails the same
way whatever the backend.

## Next steps

- [Notifications](/docs/notifications) send one event through mail, the
  database, and realtime broadcast.
- [Jobs](/docs/jobs) cover workers, retries, and the dispatch options.
