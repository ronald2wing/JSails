/**
 * The server the client tests talk to, built only from definitions: tools for
 * every call outcome (structured output, an `x-mcp-header` argument, a tool
 * failure, input requests with and without state, confirmation, an endless
 * asker, progress with cancellation, an oversized result, a gated and a
 * hidden tool), a resource, a template, and a prompt. A {@link SignalLog}
 * records each cancellation the server's handlers observe.
 */

import { z } from 'zod';

import { publicAccess, type McpAuthorize } from '../src/access.js';
import {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  defineMcpServer,
  defineMcpTool,
  type McpServerDefinition,
} from '../src/definitions.js';
import { McpToolFailure } from '../src/errors.js';
import { inputRequired } from '../src/input-required.js';

const open = publicAccess('client test fixture');
export const GATED = Object.freeze({ scope: 'notes:write' });
export const HIDDEN = Object.freeze({ deny: true });

/** A gate: `GATED` items are challenged for `notes:write` unless the actor holds it, `HIDDEN` ones hidden. */
export const authorize: McpAuthorize = (item, actor) => {
  if (item.access === HIDDEN) {
    return 'hidden';
  }
  if (item.access === GATED) {
    return actor.scopes === '*' || actor.scopes.includes('notes:write')
      ? 'allow'
      : { challenge: ['notes:write'] };
  }
  return 'allow';
};

/** Cancellations observed by the `slow` tool, in order. */
export interface SignalLog {
  readonly aborted: string[];
  push(name: string): void;
  /** Resolves at the next recorded cancellation. */
  next(): Promise<void>;
}

export function signalLog(): SignalLog {
  const aborted: string[] = [];
  let waiters: (() => void)[] = [];
  return {
    aborted,
    push(name) {
      aborted.push(name);
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) {
        resolve();
      }
    },
    next: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
  };
}

/** Build the demo server; `log` receives the `slow` tool's cancellations. */
export function demoServer(log?: SignalLog): McpServerDefinition {
  const record = (name: string): void => {
    log?.push(name);
  };
  return defineMcpServer({
    name: 'demo',
    version: '2.1.0',
    title: 'Demo server',
    instructions: 'Tools for client tests.',
    tools: [
      defineMcpTool({
        name: 'add',
        title: 'Add',
        description: 'Add two numbers.',
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ sum: z.number() }),
        annotations: { readOnly: true, idempotent: true, openWorld: false },
        access: open,
        handler: ({ a, b }) => ({ sum: a + b }),
      }),
      defineMcpTool({
        name: 'region',
        description: 'Echo a region carried in an Mcp-Param header.',
        input: z.object({ region: z.string().meta({ 'x-mcp-header': 'Region' }) }),
        access: open,
        handler: ({ region }) => `region ${region}`,
      }),
      defineMcpTool({
        name: 'fail',
        description: 'Fail on purpose.',
        access: open,
        handler: () => {
          throw new McpToolFailure('not_today', 'Not today.');
        },
      }),
      defineMcpTool({
        name: 'ask',
        description: 'Ask for a name, carrying state.',
        input: z.object({ greeting: z.string() }),
        access: open,
        handler: async ({ greeting }, ctx) => {
          const answer = await ctx.answer('name', z.object({ name: z.string() }));
          if (answer === undefined) {
            return inputRequired({
              requests: {
                name: {
                  mode: 'form',
                  message: 'Your name?',
                  schema: z.object({ name: z.string() }),
                },
              },
              state: { greeting },
            });
          }
          if (answer.action !== 'accept') {
            return answer.action;
          }
          const state = ctx.state<{ greeting: string }>();
          return `${state?.greeting ?? '?'} ${answer.content.name}`;
        },
      }),
      defineMcpTool({
        name: 'visit',
        description: 'Send the user to a page.',
        access: open,
        handler: async (_input, ctx) => {
          const answer = await ctx.answer('consent');
          if (answer === undefined) {
            return inputRequired({
              requests: {
                consent: { mode: 'url', message: 'Approve here.', url: 'https://example.com/ok' },
              },
            });
          }
          return answer.action;
        },
      }),
      defineMcpTool({
        name: 'count',
        description: 'Count rounds through state alone.',
        access: open,
        handler: (_input, ctx) => {
          const round = ctx.state<{ round: number }>()?.round ?? 0;
          return round >= 3 ? `rounds ${round}` : inputRequired({ state: { round: round + 1 } });
        },
      }),
      defineMcpTool({
        name: 'forever',
        description: 'Ask again on every round.',
        access: open,
        handler: (_input, ctx) =>
          inputRequired({
            requests: {
              again: { mode: 'form', message: 'Again?', schema: z.object({ ok: z.boolean() }) },
            },
            state: { round: (ctx.state<{ round: number }>()?.round ?? 0) + 1 },
          }),
      }),
      defineMcpTool({
        name: 'deploy',
        description: 'Confirm, then deploy.',
        access: open,
        annotations: { destructive: true },
        confirm: () => 'Deploy now?',
        handler: () => 'deployed',
      }),
      defineMcpTool({
        name: 'slow',
        description: 'Report progress, then wait for cancellation or finish.',
        input: z.object({ wait: z.boolean() }),
        access: open,
        handler: async ({ wait }, ctx) => {
          ctx.progress(1, 3, 'one');
          ctx.progress(2, 3, 'two');
          if (wait) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            record('slow');
            return 'aborted';
          }
          return 'finished';
        },
      }),
      defineMcpTool({
        name: 'big',
        description: 'Return a large text, after progress when asked.',
        input: z.object({ size: z.number().int(), progress: z.boolean() }),
        access: open,
        handler: ({ size, progress }, ctx) => {
          if (progress) {
            ctx.progress(1, 2);
          }
          return 'x'.repeat(size);
        },
      }),
      defineMcpTool({
        name: 'write_note',
        description: 'Needs notes:write.',
        access: GATED,
        handler: () => 'written',
      }),
      defineMcpTool({
        name: 'secret',
        description: 'Hidden from everyone.',
        access: HIDDEN,
        handler: () => 'secret',
      }),
    ],
    resources: [
      defineMcpResource({
        uri: 'demo://readme',
        name: 'readme',
        title: 'Read me',
        mimeType: 'text/plain',
        access: open,
        read: () => [{ text: 'hello' }],
      }),
      defineMcpResource({
        uri: 'demo://pinned',
        name: 'pinned',
        access: open,
        read: async (ctx) => {
          const answer = await ctx.answer('pin', z.object({ pin: z.string() }));
          if (answer === undefined) {
            return inputRequired({
              requests: {
                pin: { mode: 'form', message: 'PIN?', schema: z.object({ pin: z.string() }) },
              },
            });
          }
          return [{ text: answer.action === 'accept' ? `pin ${answer.content.pin}` : 'no pin' }];
        },
      }),
      defineMcpResourceTemplate({
        uriTemplate: 'demo://notes/{id}',
        name: 'note',
        params: z.object({ id: z.string() }),
        access: open,
        read: ({ id }) => [{ text: `note ${id}`, mimeType: 'text/plain' }],
      }),
    ],
    prompts: [
      defineMcpPrompt({
        name: 'greet',
        description: 'Greet someone.',
        args: z.object({ who: z.string() }),
        access: open,
        render: ({ who }) => [{ role: 'user', content: { type: 'text', text: `Greet ${who}.` } }],
      }),
    ],
  });
}
