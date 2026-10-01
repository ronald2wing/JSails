/**
 * `mailPlugin` tests: the plugin provides a `Mailer` under `mailToken`, resolves
 * its transport with the documented precedence (transport service > smtp >
 * environment > memory), fails closed by default, resolves nothing before the
 * first send, closes only a transport it owns, refuses invalid options before
 * any setup without echoing them, and sets up inertly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import { jobsToken } from 'jsails/internal';
import { checkOptionSchema, ConfigErrors, parseOptions } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';

import {
  defineMail,
  InMemoryMailTransport,
  MailError,
  mailPlugin,
  mailToken,
  mailTransportToken,
  type Mailer,
} from '../src/index.js';
import { transportProvider } from './transport-provider.js';

const MESSAGE = { to: 'ada@example.com', subject: 'hello', text: 'plain body' };
const rootDir = import.meta.dirname;

describe('mailPlugin', () => {
  it('provides a Mailer under mailToken without connecting', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })], { rootDir, env: {} });
    try {
      const mailer = runtime.services.get(mailToken);
      assert.equal(typeof mailer.send, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('exposes stable token singletons', () => {
    assert.equal(mailToken.name, 'mail');
    assert.equal(mailTransportToken.name, 'mail.transport');
  });

  it('uses the named transport service verbatim and never closes it', async () => {
    const provided = new InMemoryMailTransport();
    const runtime = await runExtensions(
      [mailPlugin({ transport: mailTransportToken }), transportProvider(provided)],
      { rootDir, env: {} },
    );
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
      assert.equal(provided.messages().length, 1);
    } finally {
      await runtime.close();
    }
    // The plugin does not own the provided transport: it is still usable.
    assert.equal(provided.messages().length, 1);
    await provided.close();
  });

  it('names a keyed transport service', async () => {
    const provided = new InMemoryMailTransport();
    const keyed = mailTransportToken.named('outbound');
    const provider = await testPlugin(mailPlugin({ transport: keyed }), {
      services: [[keyed, provided]],
    });
    try {
      await provider.services.get(mailToken).send(MESSAGE);
      assert.equal(provided.messages().length, 1);
    } finally {
      await provider.close();
      await provided.close();
    }
  });

  it('resolves the transport service ahead of smtp, the environment, and memory', async () => {
    const provided = new InMemoryMailTransport();
    const runtime = await runExtensions(
      [
        transportProvider(provided),
        mailPlugin({
          transport: mailTransportToken,
          smtp: { url: 'smtp://smtp.example.com' },
          allowMemory: true,
        }),
      ],
      {
        rootDir,
        env: { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      },
    );
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
      assert.equal(provided.messages().length, 1);
    } finally {
      await runtime.close();
    }
    await provided.close();
  });

  it('resolves the smtp option ahead of the environment and memory', async () => {
    // `http://` is rejected by the SMTP transport at construction: reaching
    // that error proves the `smtp` option won over both the environment and
    // memory.
    const runtime = await runExtensions(
      [mailPlugin({ smtp: { url: 'http://example.com' }, allowMemory: true })],
      {
        rootDir,
        env: { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      },
    );
    try {
      await assert.rejects(
        runtime.services.get(mailToken).send(MESSAGE),
        (error: unknown) => error instanceof MailError && error.code === 'invalid_smtp_url',
      );
    } finally {
      await runtime.close();
    }
  });

  for (const name of ['MAIL_URL', 'SMTP_URL']) {
    it(`resolves ${name} ahead of the in-memory fallback`, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })], {
        rootDir,
        env: { [name]: 'http://example.com' },
      });
      try {
        // The environment's URL is chosen (and rejected as non-SMTP), proving
        // it won over `allowMemory: true`, which would otherwise succeed.
        await assert.rejects(
          runtime.services.get(mailToken).send(MESSAGE),
          (error: unknown) => error instanceof MailError && error.code === 'invalid_smtp_url',
        );
      } finally {
        await runtime.close();
      }
    });
  }

  it('reads the environment it is given, never the process environment', async () => {
    const saved = process.env['MAIL_URL'];
    process.env['MAIL_URL'] = 'http://example.com';
    try {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })], {
        rootDir,
        env: {},
      });
      try {
        await runtime.services.get(mailToken).send(MESSAGE);
      } finally {
        await runtime.close();
      }
    } finally {
      if (saved === undefined) delete process.env['MAIL_URL'];
      else process.env['MAIL_URL'] = saved;
    }
  });

  it('treats a blank MAIL_URL as unset', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })], {
      rootDir,
      env: { MAIL_URL: '', SMTP_URL: '' },
    });
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
    } finally {
      await runtime.close();
    }
  });

  it('falls back to the in-memory transport only when allowMemory is true', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })], { rootDir, env: {} });
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed on the first send, not at construction or setup', async () => {
    const runtime = await runExtensions([mailPlugin()], { rootDir, env: {} });
    try {
      const mailer: Mailer = runtime.services.get(mailToken);
      await assert.rejects(
        mailer.send(MESSAGE),
        (error: unknown) =>
          error instanceof MailError &&
          error.code === 'missing_transport' &&
          !error.message.includes('ada@example.com'),
      );
    } finally {
      await runtime.close();
    }
  });

  it('closes an owned memory transport and is idempotent', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })], { rootDir, env: {} });
    const mailer = runtime.services.get(mailToken);
    await mailer.send(MESSAGE);
    await runtime.close();
    await runtime.close();
    await assert.rejects(
      mailer.send(MESSAGE),
      (error: unknown) => error instanceof MailError && error.code === 'closed',
    );
  });

  it('refuses a transport token another plugin does not provide', async () => {
    await assert.rejects(
      runExtensions([mailPlugin({ transport: mailTransportToken })], { rootDir, env: {} }),
    );
  });

  it('sets up inertly, providing only mailToken and registering no route outside development', async () => {
    const run = await testPlugin(mailPlugin({ smtp: { host: 'smtp.example.com' } }), {
      env: { MAIL_URL: 'smtp://smtp.example.com' },
    });
    try {
      assert.deepEqual(run.provided, [mailToken]);
      assert.equal(run.http.routes.length, 0);
    } finally {
      await run.close();
    }
  });

  it('sets up inertly in development, registering the preview routes', async () => {
    const run = await testPlugin(mailPlugin({ allowMemory: true }), {
      env: { NODE_ENV: 'development' },
    });
    try {
      assert.equal(run.http.routes.length, 3);
    } finally {
      await run.close();
    }
  });

  it('declares its options, the services they name and its variables', () => {
    assert.deepEqual(checkOptionSchema(mailPlugin.definition.options!), []);
    assert.deepEqual(mailPlugin().provides, [mailToken]);
    assert.deepEqual(mailPlugin().optional, [jobsToken]);
    assert.deepEqual(mailPlugin().requires, []);
    assert.deepEqual(mailPlugin({ transport: mailTransportToken }).requires, [mailTransportToken]);
    assert.deepEqual(Object.keys(mailPlugin.definition.env ?? {}), ['MAIL_URL', 'SMTP_URL']);
  });

  it('keeps a template preview reduced to its name, props and bound renderer', () => {
    const Welcome = defineMail<{ readonly name: string }>('welcome', {
      subject: 'Welcome',
      render: (props) => <p>Hello {props.name}</p>,
      preview: { name: 'Ada' },
    });
    const parsed = parseOptions('mail', mailPlugin.definition.options!, { previews: [Welcome] });
    const [entry] = (parsed as { previews: readonly Record<string, unknown>[] }).previews;
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ['name', 'preview', 'render']);
  });

  const SECRET = 'zz-secret-input';
  const Twice = defineMail('twice', { subject: SECRET, render: () => <p>{SECRET}</p> });
  const invalidOptions: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'null', input: null },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'a non-boolean allowMemory', input: { allowMemory: SECRET } },
    { name: 'a transport instance', input: { transport: new InMemoryMailTransport() } },
    { name: 'a token of another family', input: { transport: mailToken } },
    { name: 'a non-object smtp', input: { smtp: SECRET } },
    { name: 'an unknown smtp field', input: { smtp: { [SECRET]: SECRET } } },
    { name: 'a non-integer smtp port', input: { smtp: { port: SECRET } } },
    { name: 'a non-array preview list', input: { previews: SECRET } },
    { name: 'a preview without a renderer', input: { previews: [{ name: SECRET }] } },
    { name: 'a mail listed twice', input: { previews: [Twice, Twice] } },
    {
      name: 'preview props that are not JSON',
      input: { previews: [{ name: 'dated', preview: { at: new Date(), SECRET }, render() {} }] },
    },
  ];
  for (const { name, input } of invalidOptions) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = mailPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(`${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET), false);
          return true;
        },
      );
    });
  }
});
