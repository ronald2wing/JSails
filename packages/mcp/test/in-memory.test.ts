/**
 * The client against a defined server in process (`connectInMemory`), in the
 * modern, legacy, and auto modes: server info, the listing (order, titles,
 * annotations, gated and hidden tools), each call outcome kept apart (`ok`
 * with checked structured output, `tool_error`, `input_required`), the
 * multi-round-trip input flow through an `elicit` handler (forms, URLs,
 * state-only rounds, confirmation, the round limit, a failing or invalid
 * handler), progress, abort with the server's signal firing, the deadline,
 * the result size cap, resources, templates, prompts, closing, option
 * validation, a legacy connection without elicitation reporting
 * `input_required`, and content annotations surviving the round trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { publicAccess } from '../src/access.js';
import { toolResult } from '../src/content.js';
import { defineMcpServer, defineMcpTool } from '../src/definitions.js';
import { McpClientError } from '../src/errors.js';
import { connectInMemory, type McpInMemoryOptions } from '../src/in-memory.js';
import {
  checkRemoteOptions,
  openRemote,
  type McpElicitation,
  type McpRemoteServer,
} from '../src/remote-client.js';
import { MessageGuard } from '../src/remote-transport.js';
import { authorize, demoServer, signalLog } from './demo-server.js';
import { errorSink, within } from './fixtures.js';

type Mode = 'modern' | 'legacy' | 'auto';
const MODES: readonly Mode[] = ['modern', 'legacy', 'auto'];

function textOf(outcome: { status: string; content?: readonly { type: string }[] }): string {
  return (outcome.content ?? [])
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

async function clientError(call: Promise<unknown>): Promise<McpClientError> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof McpClientError, `expected McpClientError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject');
}

async function connect(
  mode: Mode,
  options: McpInMemoryOptions = {},
  log = signalLog(),
): Promise<McpRemoteServer> {
  return connectInMemory(demoServer(log), {
    protocol: mode,
    serving: { authorize, onError: () => undefined },
    ...options,
  });
}

for (const mode of MODES) {
  describe(`connectInMemory (${mode})`, () => {
    it('reports the server and lists tools in definition order, without hidden ones', async () => {
      const remote = await connect(mode);
      try {
        assert.equal(remote.info.name, 'demo');
        assert.equal(remote.info.version, '2.1.0');
        assert.equal(remote.info.era, mode === 'legacy' ? 'legacy' : 'modern');
        assert.equal(remote.info.protocolVersion, mode === 'legacy' ? '2025-11-25' : '2026-07-28');
        assert.equal(remote.info.instructions, 'Tools for client tests.');
        assert.ok(Object.isFrozen(remote.info.capabilities));
        const tools = await remote.listTools();
        const names = tools.map((tool) => tool.name);
        assert.ok(!names.includes('secret'));
        assert.ok(names.includes('write_note'));
        assert.deepEqual([...names].sort(), names);
        const add = tools.find((tool) => tool.name === 'add');
        assert.equal(add?.title, 'Add');
        assert.equal(add?.description, 'Add two numbers.');
        assert.deepEqual(add?.annotations, { readOnly: true, idempotent: true, openWorld: false });
        assert.equal(add?.outputSchema?.type, 'object');
        assert.ok(Object.isFrozen(add?.inputSchema));
        assert.ok(Object.isFrozen(tools));
      } finally {
        await remote.close();
      }
    });

    it('returns ok with checked structured output, and tool_error apart from it', async () => {
      const remote = await connect(mode);
      try {
        const ok = await remote.callTool('add', { a: 2, b: 3 });
        assert.equal(ok.status, 'ok');
        assert.ok(ok.status === 'ok');
        assert.deepEqual(ok.structured, { sum: 5 });
        assert.deepEqual(JSON.parse(textOf(ok)), { sum: 5 });
        assert.ok(Object.isFrozen(ok.content));

        const failed = await remote.callTool('fail');
        assert.equal(failed.status, 'tool_error');
        assert.ok(failed.status === 'tool_error');
        assert.deepEqual(failed.structured, { code: 'not_today', message: 'Not today.' });

        const invalid = await remote.callTool('add', { a: 'two', b: 3 });
        assert.equal(invalid.status, 'tool_error');
        assert.ok(invalid.status === 'tool_error');
        assert.deepEqual(invalid.structured, {
          code: 'invalid_arguments',
          message: 'Invalid arguments at: a.',
        });
      } finally {
        await remote.close();
      }
    });

    it('refuses hidden and unknown tools locally, and reports a challenged one as a tool error', async () => {
      const remote = await connect(mode);
      try {
        assert.equal((await clientError(remote.callTool('secret'))).code, 'unknown_tool');
        assert.equal((await clientError(remote.callTool('nope'))).code, 'unknown_tool');
        const gated = await remote.callTool('write_note');
        assert.equal(gated.status, 'tool_error');
        assert.ok(gated.status === 'tool_error');
        assert.deepEqual(gated.structured, {
          code: 'insufficient_scope',
          message: 'The credential lacks a scope this tool needs.',
          scopes: ['notes:write'],
        });
      } finally {
        await remote.close();
      }
    });

    it('answers form input through the elicit handler and carries state', async () => {
      const seen: McpElicitation[] = [];
      const remote = await connect(mode, {
        elicit: (request) => {
          seen.push(request);
          return { action: 'accept', content: { name: 'Ada' } };
        },
      });
      try {
        const outcome = await remote.callTool('ask', { greeting: 'Hello' });
        assert.equal(outcome.status, 'ok');
        assert.equal(textOf(outcome), 'Hello Ada');
        assert.equal(seen.length, 1);
        const [request] = seen;
        assert.equal(request?.mode, 'form');
        assert.equal(request?.message, 'Your name?');
        assert.equal(request?.key, mode === 'legacy' ? undefined : 'name');
        assert.ok(request?.mode === 'form' && Object.isFrozen(request.schema));
      } finally {
        await remote.close();
      }
    });

    it('passes a decline back to the server and confirms through the handler', async () => {
      const remote = await connect(mode, { elicit: () => ({ action: 'decline' }) });
      try {
        assert.equal(textOf(await remote.callTool('ask', { greeting: 'Hi' })), 'decline');
        const refused = await remote.callTool('deploy');
        assert.equal(refused.status, 'tool_error');
        assert.ok(refused.status === 'tool_error');
        assert.equal((refused.structured as { code: string }).code, 'not_confirmed');
      } finally {
        await remote.close();
      }
      const yes = await connect(mode, {
        elicit: () => ({ action: 'accept', content: { confirm: true } }),
      });
      try {
        assert.equal(textOf(await yes.callTool('deploy')), 'deployed');
      } finally {
        await yes.close();
      }
    });

    it('answers URL requests with consent only', async () => {
      const seen: McpElicitation[] = [];
      const remote = await connect(mode, {
        elicit: (request) => {
          seen.push(request);
          return { action: 'accept', content: { ignored: 'x' } };
        },
      });
      try {
        assert.equal(textOf(await remote.callTool('visit')), 'accept');
        assert.equal(seen[0]?.mode, 'url');
        assert.ok(seen[0]?.mode === 'url' && seen[0].url === 'https://example.com/ok');
      } finally {
        await remote.close();
      }
    });

    it('retries state-only rounds without asking the handler', async () => {
      let asked = 0;
      const remote = await connect(mode, {
        elicit: () => {
          asked += 1;
          return { action: 'cancel' };
        },
      });
      try {
        assert.equal(textOf(await remote.callTool('count')), 'rounds 3');
        assert.equal(asked, 0);
      } finally {
        await remote.close();
      }
    });

    it('reads resources, templates, and prompts', async () => {
      const remote = await connect(mode);
      try {
        const resources = await remote.listResources();
        assert.deepEqual(
          resources.map((resource) => resource.uri),
          ['demo://pinned', 'demo://readme'],
        );
        const readme = resources.find((resource) => resource.name === 'readme');
        assert.equal(readme?.title, 'Read me');
        assert.equal(readme?.mimeType, 'text/plain');
        assert.deepEqual(await remote.readResource('demo://readme'), [
          // The body names no MIME type, so it carries the one the resource declares.
          { uri: 'demo://readme', mimeType: 'text/plain', text: 'hello' },
        ]);
        const templates = await remote.listResourceTemplates();
        assert.deepEqual(
          templates.map((template) => template.uriTemplate),
          ['demo://notes/{id}'],
        );
        assert.deepEqual(await remote.readResource('demo://notes/7'), [
          { uri: 'demo://notes/7', mimeType: 'text/plain', text: 'note 7' },
        ]);
        const prompts = await remote.listPrompts();
        assert.equal(prompts[0]?.name, 'greet');
        assert.deepEqual(prompts[0]?.arguments, [
          { name: 'who', description: undefined, required: true },
        ]);
        const messages = await remote.getPrompt('greet', { who: 'Bob' });
        assert.deepEqual(messages, [
          { role: 'user', content: { type: 'text', text: 'Greet Bob.' } },
        ]);
        assert.ok(Object.isFrozen(messages));
        const missing = await clientError(remote.readResource('demo://missing'));
        assert.equal(missing.code, 'protocol_error');
        assert.equal(missing.rpcCode, -32602);
        assert.equal(missing.message, 'The MCP server refused the request.');
      } finally {
        await remote.close();
      }
    });

    it('reports progress in increasing order', async () => {
      const remote = await connect(mode);
      try {
        const progress: [number, number | undefined, string | undefined][] = [];
        const outcome = await remote.callTool(
          'slow',
          { wait: false },
          { onProgress: (done, total, message) => void progress.push([done, total, message]) },
        );
        assert.equal(textOf(outcome), 'finished');
        assert.deepEqual(progress, [
          [1, 3, 'one'],
          [2, 3, 'two'],
        ]);
      } finally {
        await remote.close();
      }
    });

    it('aborts a call and the server handler sees the cancellation', async () => {
      const log = signalLog();
      const remote = await connect(mode, {}, log);
      try {
        const controller = new AbortController();
        const cancelled = log.next();
        const call = remote.callTool(
          'slow',
          { wait: true },
          { signal: controller.signal, onProgress: () => controller.abort() },
        );
        assert.equal((await clientError(call)).code, 'aborted');
        await within(cancelled, 'the slow handler seeing the cancellation');
        assert.deepEqual(log.aborted, ['slow']);
        const aborted = new AbortController();
        aborted.abort();
        const early = await clientError(remote.callTool('add', { a: 1, b: 1 }, aborted));
        assert.equal(early.code, 'aborted');
        assert.equal((await remote.callTool('add', { a: 1, b: 1 })).status, 'ok');
      } finally {
        await remote.close();
      }
    });

    it('times a call out by its deadline', async () => {
      const remote = await connect(mode);
      try {
        const late = await clientError(remote.callTool('slow', { wait: true }, { timeoutMs: 50 }));
        assert.equal(late.code, 'timeout');
      } finally {
        await remote.close();
      }
    });

    it('refuses a result over maxResultBytes and keeps the connection usable', async () => {
      const remote = await connect(mode, { maxResultBytes: 20_000 });
      try {
        const small = await remote.callTool('big', { size: 100, progress: false });
        assert.equal(textOf(small).length, 100);
        const large = await clientError(remote.callTool('big', { size: 50_000, progress: false }));
        assert.equal(large.code, 'result_too_large');
        assert.equal((await remote.callTool('add', { a: 1, b: 2 })).status, 'ok');
      } finally {
        await remote.close();
      }
    });

    it('closes idempotently and refuses calls afterwards', async () => {
      const remote = await connect(mode);
      await remote.close();
      await remote.close();
      assert.equal((await clientError(remote.listTools())).code, 'closed');
      assert.equal((await clientError(remote.callTool('add', { a: 1, b: 1 }))).code, 'closed');
    });
  });
}

describe('connectInMemory input without a handler', () => {
  it('returns input_required on a modern connection and throws it for a resource', async () => {
    const remote = await connect('modern');
    try {
      assert.deepEqual(await remote.callTool('ask', { greeting: 'Hi' }), {
        status: 'input_required',
      });
      assert.equal(
        (await clientError(remote.readResource('demo://pinned'))).code,
        'input_required',
      );
      const refused = await remote.callTool('deploy');
      assert.equal(refused.status, 'tool_error');
      assert.ok(refused.status === 'tool_error');
      assert.equal((refused.structured as { code: string }).code, 'confirmation_unavailable');
    } finally {
      await remote.close();
    }
  });

  it('answers a resource input request when a handler is configured', async () => {
    const remote = await connect('modern', {
      elicit: () => ({ action: 'accept', content: { pin: '1234' } }),
    });
    try {
      assert.deepEqual(await remote.readResource('demo://pinned'), [
        { uri: 'demo://pinned', text: 'pin 1234' },
      ]);
    } finally {
      await remote.close();
    }
  });

  it('reports input_required on a legacy connection without elicitation, never SDK text', async () => {
    const errors = errorSink();
    const remote = await connect('legacy', { serving: { authorize, onError: errors.onError } });
    try {
      assert.deepEqual(await remote.callTool('ask', { greeting: 'Hi' }), {
        status: 'input_required',
      });
      assert.deepEqual(await remote.callTool('visit'), { status: 'input_required' });
      assert.equal(
        (await clientError(remote.readResource('demo://pinned'))).code,
        'input_required',
      );
      const refused = await remote.callTool('deploy');
      assert.ok(refused.status === 'tool_error');
      assert.equal((refused.structured as { code: string }).code, 'confirmation_unavailable');
      assert.deepEqual(errors.errors, []);
    } finally {
      await remote.close();
    }
  });
});

describe('connectInMemory input rounds and handler failures', () => {
  it('stops at maxInputRounds', async () => {
    let asked = 0;
    const remote = await connect('modern', {
      maxInputRounds: 2,
      serving: { authorize, maxInputRounds: 50, onError: () => undefined },
      elicit: () => {
        asked += 1;
        return { action: 'accept', content: { ok: true } };
      },
    });
    try {
      assert.equal((await clientError(remote.callTool('forever'))).code, 'input_rounds_exceeded');
      assert.equal(asked, 2);
    } finally {
      await remote.close();
    }
  });

  for (const mode of ['modern', 'legacy'] as const) {
    it(`reports a throwing or invalid handler as elicit_failed (${mode})`, async () => {
      const cause = new Error('handler secret');
      const throwing = await connect(mode, {
        elicit: () => {
          throw cause;
        },
      });
      try {
        if (mode === 'modern') {
          const failure = await clientError(throwing.callTool('ask', { greeting: 'Hi' }));
          assert.equal(failure.code, 'elicit_failed');
          assert.equal(failure.cause, cause);
          assert.ok(!failure.message.includes('secret'));
        } else {
          const outcome = await throwing.callTool('ask', { greeting: 'Hi' });
          assert.equal(outcome.status, 'tool_error');
          assert.ok(!JSON.stringify(outcome).includes('secret'));
        }
      } finally {
        await throwing.close();
      }
      const invalid = await connect(mode, {
        elicit: () => ({ action: 'accept', content: { name: 42 } }),
      });
      try {
        if (mode === 'modern') {
          const failure = await clientError(invalid.callTool('ask', { greeting: 'Hi' }));
          assert.equal(failure.code, 'elicit_failed');
        } else {
          const outcome = await invalid.callTool('ask', { greeting: 'Hi' });
          assert.equal(outcome.status, 'tool_error');
        }
      } finally {
        await invalid.close();
      }
    });
  }
});

describe('connectInMemory actors and serving options', () => {
  it('serves an anonymous actor by default and the given actor otherwise', async () => {
    const anonymous = await connect('modern');
    try {
      assert.equal((await anonymous.callTool('write_note')).status, 'tool_error');
    } finally {
      await anonymous.close();
    }
    const writer = await connect('modern', {
      actor: { kind: 'user', id: 'u1', scopes: ['notes:write'] },
    });
    try {
      assert.equal(textOf(await writer.callTool('write_note')), 'written');
    } finally {
      await writer.close();
    }
  });

  it('reports serving errors through the serving hook', async () => {
    const sink = errorSink();
    const remote = await connectInMemory(demoServer(), {
      serving: { authorize, onError: sink.onError, maxResultBytes: 1_000 },
    });
    try {
      const outcome = await remote.callTool('big', { size: 5_000, progress: false });
      assert.equal(outcome.status, 'tool_error');
      assert.deepEqual(
        sink.errors.map((error) => error.code),
        ['result_too_large'],
      );
    } finally {
      await remote.close();
    }
  });

  it('refuses malformed options', async () => {
    const bad: unknown[] = [
      null,
      { protocol: 'future' },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { maxResultBytes: -1 },
      { maxInputRounds: 1_000 },
      { elicit: 'yes' },
      { onToolExcluded: 1 },
      { signal: {} },
      { clientInfo: { name: '' } },
      { actor: { kind: 'robot', scopes: [] } },
      { unknown: true },
    ];
    for (const options of bad) {
      const failure = await clientError(
        connectInMemory(demoServer(), options as McpInMemoryOptions),
      );
      assert.equal(failure.code, 'invalid_option', JSON.stringify(options));
    }
    const remote = await connect('modern');
    try {
      assert.equal((await clientError(remote.callTool(''))).code, 'invalid_option');
      assert.equal((await clientError(remote.callTool('add', [] as never))).code, 'invalid_option');
      assert.equal(
        (await clientError(remote.callTool('add', { a: Number.NaN, b: 1 }))).code,
        'invalid_option',
      );
      assert.equal(
        (await clientError(remote.callTool('add', { a: 1, b: 1 }, { timeoutMs: -5 }))).code,
        'invalid_option',
      );
      assert.equal((await clientError(remote.readResource('not a uri'))).code, 'invalid_option');
      assert.equal(
        (await clientError(remote.getPrompt('greet', { who: 1 } as never))).code,
        'invalid_option',
      );
    } finally {
      await remote.close();
    }
  });

  it('aborts connecting with an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await clientError(
      connectInMemory(demoServer(), { signal: controller.signal, serving: { authorize } }),
    );
    assert.equal(failure.code, 'aborted');
  });
});

describe('connectInMemory content metadata', () => {
  it('keeps annotations and resource link metadata through the round trip', async () => {
    const forUser = { audience: ['user'], priority: 1 } as const;
    const server = defineMcpServer({
      name: 'annotated',
      version: '1.0.0',
      tools: [
        defineMcpTool({
          name: 'mixed',
          description: 'Content for the user and for the model.',
          access: publicAccess('test fixture'),
          handler: () =>
            toolResult.content([
              { type: 'text', text: 'shown to the user', annotations: forUser },
              { type: 'text', text: 'for the model', annotations: { audience: ['assistant'] } },
              {
                type: 'resource_link',
                uri: 'demo://file',
                name: 'file',
                size: 42,
                icons: [{ src: 'https://example.com/file.png' }],
                annotations: { lastModified: '2026-11-19T00:00:00Z' },
              },
            ]),
        }),
      ],
    });
    for (const protocol of MODES) {
      const remote = await connectInMemory(server, { protocol });
      try {
        const outcome = await remote.callTool('mixed');
        assert.ok(outcome.status === 'ok');
        assert.deepEqual(outcome.content, [
          { type: 'text', text: 'shown to the user', annotations: forUser },
          { type: 'text', text: 'for the model', annotations: { audience: ['assistant'] } },
          {
            type: 'resource_link',
            uri: 'demo://file',
            name: 'file',
            size: 42,
            icons: [{ src: 'https://example.com/file.png' }],
            annotations: { lastModified: '2026-11-19T00:00:00Z' },
          },
        ]);
      } finally {
        await remote.close();
      }
    }
  });
});

describe('connect failures', () => {
  it('reports a server that fails the handshake as connect_failed, not unsupported_protocol', async () => {
    for (const protocol of MODES) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const handle = serveStdio(() => Promise.reject(new Error('the factory failed')), {
        legacy: 'serve',
        transport: serverSide,
        onerror: () => undefined,
      });
      const settings = checkRemoteOptions({ protocol }, []);
      const error = await clientError(
        openRemote(clientSide, settings, new MessageGuard(settings.maxResultBytes), () =>
          handle.close(),
        ),
      );
      assert.equal(error.code, 'connect_failed', protocol);
    }
  });
});
