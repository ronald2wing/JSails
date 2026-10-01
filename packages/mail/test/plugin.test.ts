/**
 * `mailPlugin` tests: the plugin provides a `Mailer` under `mailToken`, resolves
 * its transport with the documented precedence (explicit transport > smtp >
 * env > memory), fails closed by default, resolves nothing before the first
 * send, and closes only a transport it owns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import {
  InMemoryMailTransport,
  MailError,
  mailPlugin,
  mailToken,
  type Mailer,
} from '../src/index.js';

const MESSAGE = { to: 'ada@example.com', subject: 'hello', text: 'plain body' };

/** Save/restore the SMTP URL variables around an env-mutating test. */
function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const names = Object.keys(vars);
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    const value = vars[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return run().finally(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

describe('mailPlugin', () => {
  it('provides a Mailer under mailToken without connecting', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
    try {
      const mailer = runtime.services.get(mailToken);
      assert.equal(typeof mailer.send, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('exposes a stable mailToken singleton', () => {
    assert.equal(mailToken.name, 'mail');
  });

  it('uses an explicit transport verbatim and never closes it', async () => {
    const explicit = new InMemoryMailTransport();
    const runtime = await runExtensions([mailPlugin({ transport: explicit })]);
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
      assert.equal(explicit.messages().length, 1);
    } finally {
      await runtime.close();
    }
    // The plugin does not own the explicit transport: it is still usable.
    assert.equal(explicit.messages().length, 1);
    await explicit.close();
  });

  it('resolves the explicit transport ahead of smtp, env, and memory', async () => {
    const explicit = new InMemoryMailTransport();
    await withEnv(
      { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      async () => {
        const runtime = await runExtensions([
          mailPlugin({
            transport: explicit,
            smtp: { url: 'smtp://smtp.example.com' },
            allowMemory: true,
          }),
        ]);
        try {
          await runtime.services.get(mailToken).send(MESSAGE);
          assert.equal(explicit.messages().length, 1);
        } finally {
          await runtime.close();
        }
      },
    );
    await explicit.close();
  });

  it('resolves the smtp option ahead of env and memory', async () => {
    await withEnv(
      { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      async () => {
        // `http://` is rejected by the SMTP transport at construction: reaching
        // that error proves the `smtp` option won over both env and memory.
        const runtime = await runExtensions([
          mailPlugin({ smtp: { url: 'http://example.com' }, allowMemory: true }),
        ]);
        try {
          await assert.rejects(
            runtime.services.get(mailToken).send(MESSAGE),
            (error: unknown) => error instanceof MailError && error.code === 'invalid_smtp_url',
          );
        } finally {
          await runtime.close();
        }
      },
    );
  });

  it('resolves MAIL_URL ahead of the in-memory fallback', async () => {
    await withEnv({ MAIL_URL: 'http://example.com', SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      try {
        // The env SMTP URL is chosen (and rejected as non-SMTP), proving env
        // won over `allowMemory: true`, which would otherwise have succeeded.
        await assert.rejects(
          runtime.services.get(mailToken).send(MESSAGE),
          (error: unknown) => error instanceof MailError && error.code === 'invalid_smtp_url',
        );
      } finally {
        await runtime.close();
      }
    });
  });

  it('falls back to the in-memory transport only when allowMemory is true', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      try {
        await runtime.services.get(mailToken).send(MESSAGE);
      } finally {
        await runtime.close();
      }
    });
  });

  it('fails closed on the first send, not at import or setup', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      // Construction and setup succeed: nothing is resolved eagerly.
      const runtime = await runExtensions([mailPlugin()]);
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
  });

  it('closes an owned memory transport and is idempotent', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      const mailer = runtime.services.get(mailToken);
      await mailer.send(MESSAGE);
      await runtime.close();
      await runtime.close();
      await assert.rejects(
        mailer.send(MESSAGE),
        (error: unknown) => error instanceof MailError && error.code === 'closed',
      );
    });
  });

  it('rejects malformed options at construction', () => {
    assert.throws(() => mailPlugin({ allowMemory: 'yes' } as never), TypeError);
    assert.throws(() => mailPlugin({ transport: {} } as never), TypeError);
    assert.throws(() => mailPlugin({ smtp: 'not-an-object' } as never), TypeError);
  });
});
