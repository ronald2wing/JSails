/**
 * Mail preview tests: the routes exist only in development mode, list and
 * render the given templates with their preview props, show the in-memory
 * outbox, answer only a loopback peer, and serve every rendered mail under a
 * sandbox policy. The routes run inside the real request pipeline, as they do
 * when served, because the loopback check reads the request frame.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp } from 'jsails';
import { runExtensions, type JsailsExtension } from 'jsails/extensions';
import type { PluginInstance } from 'jsails/kernel';

import {
  defineMail,
  InMemoryMailTransport,
  MAIL_PREVIEW_PATH,
  mailPlugin,
  mailToken,
  mailTransportToken,
} from '../src/index.js';
import { transportProvider } from './transport-provider.js';

/** The assembled app the tests send requests to. */
type TestApp = Awaited<ReturnType<typeof createApp>>;

const Welcome = defineMail<{ readonly name: string }>('welcome', {
  subject: (props) => `Welcome, ${props.name}`,
  render: (props) => <p>Hello {props.name}</p>,
  preview: { name: '<Ada>' },
});

const NoPreview = defineMail<{ readonly id: number }>('no-preview', {
  subject: 'Bare',
  render: (props) => <p>{props.id}</p>,
});

/** Run `entries` in `nodeEnv`'s mode and serve their routes through the real pipeline. */
async function serve(
  entries: readonly (JsailsExtension | PluginInstance)[],
  nodeEnv: string | undefined,
) {
  const runtime = await runExtensions(entries, {
    rootDir: import.meta.dirname,
    env: { NODE_ENV: nodeEnv },
  });
  const app = await createApp({
    manifest: { entries: [], byRoute: new Map() },
    contributions: { routes: runtime.routes, transforms: runtime.transforms },
  });
  return { app, runtime };
}

function mount(nodeEnv: string | undefined) {
  return serve([mailPlugin({ allowMemory: true, previews: [Welcome, NoPreview] })], nodeEnv);
}

/**
 * Request `path` as the Node adapter would serve it from `address`: the peer
 * address rides on the Hono env's `incoming.socket`, as `@hono/node-server`
 * passes it.
 */
function fromPeer(
  app: TestApp,
  path: string,
  address = '127.0.0.1',
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  return app.request(path, { headers }, { incoming: { socket: { remoteAddress: address } } });
}

describe('mail preview gating', () => {
  for (const nodeEnv of ['production', 'test', 'Development', undefined]) {
    it(`registers no route when NODE_ENV is ${String(nodeEnv)}`, async () => {
      const { app, runtime } = await mount(nodeEnv);
      try {
        assert.equal(runtime.routes.length, 0);
        assert.equal((await app.request(MAIL_PREVIEW_PATH)).status, 404);
      } finally {
        await runtime.close();
      }
    });
  }
});

describe('mail preview in development', () => {
  it('lists templates and an empty outbox before anything is sent', async () => {
    const { app, runtime } = await mount('development');
    try {
      const response = await fromPeer(app, MAIL_PREVIEW_PATH);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.ok(body.startsWith('<!DOCTYPE html>'));
      assert.ok(body.includes(`href="${MAIL_PREVIEW_PATH}/templates/welcome"`));
      assert.ok(body.includes('no-preview (no preview props)'));
      assert.ok(body.includes('allowMemory: true'));
    } finally {
      await runtime.close();
    }
  });

  it('renders a template with its preview props under a sandbox policy', async () => {
    const { app, runtime } = await mount('development');
    try {
      const html = await fromPeer(app, `${MAIL_PREVIEW_PATH}/templates/welcome`);
      assert.equal(html.status, 200);
      assert.match(html.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(html.headers.get('content-security-policy') ?? '', /^sandbox;/);
      assert.equal(await html.text(), '<p>Hello &lt;Ada></p>');

      const text = await fromPeer(app, `${MAIL_PREVIEW_PATH}/templates/welcome?part=text`);
      assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(await text.text(), 'Hello <Ada>');

      assert.equal((await fromPeer(app, `${MAIL_PREVIEW_PATH}/templates/no-preview`)).status, 404);
      assert.equal((await fromPeer(app, `${MAIL_PREVIEW_PATH}/templates/missing`)).status, 404);
    } finally {
      await runtime.close();
    }
  });

  it('shows the in-memory outbox', async () => {
    const { app, runtime } = await mount('development');
    try {
      await runtime.services
        .get(mailToken)
        .send(Welcome.message({ to: 'ada@example.com' }, { name: 'Ada' }));
      await runtime.services
        .get(mailToken)
        .send({ to: 'b@example.com', subject: 'Plain only', text: 'just text' });

      const index = await (await fromPeer(app, MAIL_PREVIEW_PATH)).text();
      assert.ok(index.includes('Welcome, Ada'));
      assert.ok(index.includes(`href="${MAIL_PREVIEW_PATH}/outbox/1"`));

      const first = await fromPeer(app, `${MAIL_PREVIEW_PATH}/outbox/0`);
      assert.match(first.headers.get('content-security-policy') ?? '', /^sandbox;/);
      assert.equal(await first.text(), '<p>Hello Ada</p>');

      // A message without HTML is shown as its text part.
      const second = await fromPeer(app, `${MAIL_PREVIEW_PATH}/outbox/1`);
      assert.match(second.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(await second.text(), 'just text');

      assert.equal((await fromPeer(app, `${MAIL_PREVIEW_PATH}/outbox/2`)).status, 404);
      assert.equal((await fromPeer(app, `${MAIL_PREVIEW_PATH}/outbox/-1`)).status, 404);
    } finally {
      await runtime.close();
    }
  });

  it('shows a provided in-memory transport as an empty outbox before any send', async () => {
    const transport = new InMemoryMailTransport();
    const { app, runtime } = await serve(
      [
        transportProvider(transport),
        mailPlugin({ transport: mailTransportToken, previews: [Welcome] }),
      ],
      'development',
    );
    try {
      const before = await (await fromPeer(app, MAIL_PREVIEW_PATH)).text();
      assert.ok(before.includes('Nothing sent yet.'));
      assert.ok(!before.includes('allowMemory: true'));

      await transport.send({ to: 'ada@example.com', subject: 'Direct', text: 'sent directly' });
      const after = await (await fromPeer(app, MAIL_PREVIEW_PATH)).text();
      assert.ok(after.includes('Direct'));
    } finally {
      await runtime.close();
    }
  });

  it('answers only requests whose socket peer is this machine', async () => {
    const { app, runtime } = await mount('development');
    try {
      for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        assert.equal((await fromPeer(app, MAIL_PREVIEW_PATH, address)).status, 200, address);
      }
      // A LAN peer cannot read the outbox or render a template, and learns
      // nothing beyond a plain 404.
      for (const path of [
        MAIL_PREVIEW_PATH,
        `${MAIL_PREVIEW_PATH}/templates/welcome`,
        `${MAIL_PREVIEW_PATH}/outbox/0`,
      ]) {
        const response = await fromPeer(app, path, '192.168.1.20');
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), 'Not found');
      }
      // A forwarding header is a proxy relaying someone else, so a loopback
      // peer with one is refused; claiming loopback in a header grants nothing.
      assert.equal(
        (await fromPeer(app, MAIL_PREVIEW_PATH, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5' }))
          .status,
        404,
      );
      assert.equal(
        (await fromPeer(app, MAIL_PREVIEW_PATH, '10.0.0.5', { 'x-forwarded-for': '127.0.0.1' }))
          .status,
        404,
      );
      // No socket at all (an in-process request) fails closed.
      assert.equal((await app.request(MAIL_PREVIEW_PATH)).status, 404);
    } finally {
      await runtime.close();
    }
  });

  it('registers its routes as public GET routes of the mail plugin', async () => {
    const { runtime } = await mount('development');
    try {
      assert.deepEqual(
        runtime.routes.map((route) =>
          route.type === 'route'
            ? [route.methods, route.path, route.access.kind, route.owner]
            : route.type,
        ),
        [
          [['GET'], MAIL_PREVIEW_PATH, 'public', 'mail'],
          [['GET'], `${MAIL_PREVIEW_PATH}/templates/:name`, 'public', 'mail'],
          [['GET'], `${MAIL_PREVIEW_PATH}/outbox/:index`, 'public', 'mail'],
        ],
      );
    } finally {
      await runtime.close();
    }
  });
});
