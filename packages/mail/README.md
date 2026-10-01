# @jsails/mail

A transport-agnostic mail seam for [JSails](https://jsails.org): the `Mailer` contract, an in-memory transport for tests, a callback transport for custom delivery, and a lazy SMTP transport over nodemailer, exposed to the application by `mailPlugin` with fail-closed transport resolution. Templates are Preact components (`defineMail`), `Mail.queue` sends from a background job, and development serves a preview of every template and of the in-memory outbox.

```sh
npm install @jsails/mail
```

Documentation: <https://jsails.org/docs/mail>
