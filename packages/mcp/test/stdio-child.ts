/**
 * A child process for stdio tests: serves a small server over this process's
 * stdin and stdout with `serveMcpStdio`, then exits when the connection
 * closes. Operator reports go to stderr as one code per line, so the parent
 * can assert both on them and on stdout carrying protocol frames only. The
 * `cancelled` tool answers once the `slow` tool's handler has seen a given
 * number of cancellations, so a client that cannot read stderr can still
 * assert that its cancellation reached the handler.
 */

import { EventEmitter, once } from 'node:events';

import { z } from 'zod';

import { publicAccess } from '../src/access.js';
import { defineMcpServer, defineMcpTool } from '../src/definitions.js';
import { inputRequired } from '../src/input-required.js';
import { serveMcpStdio } from '../src/stdio.js';

const open = publicAccess('test fixture');
const cancellations = new EventEmitter();
let cancelled = 0;

const server = defineMcpServer({
  name: 'stdio-fixture',
  version: '1.0.0',
  tools: [
    defineMcpTool({
      name: 'whoami',
      description: 'Name the actor kind.',
      access: open,
      handler: (_input, ctx) => `${ctx.actor.kind} ${ctx.actor.scopes === '*' ? '*' : 'scoped'}`,
    }),
    defineMcpTool({
      name: 'ask',
      description: 'Ask for a name, carrying state.',
      access: open,
      handler: async (_input, ctx) => {
        const answer = await ctx.answer('name', z.object({ name: z.string() }));
        if (answer === undefined) {
          return inputRequired({
            requests: {
              name: { mode: 'form', message: 'Your name?', schema: z.object({ name: z.string() }) },
            },
            state: { round: 1 },
          });
        }
        return answer.action === 'accept'
          ? `Hello ${answer.content.name} (state ${JSON.stringify(ctx.state())})`
          : answer.action;
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
      confirm: () => 'Deploy?',
      handler: () => 'deployed',
    }),
    defineMcpTool({
      name: 'slow',
      description: 'Report progress, then wait for cancellation or finish.',
      input: z.object({ wait: z.boolean() }),
      access: open,
      handler: async ({ wait }, ctx) => {
        ctx.progress(1, 2, 'half');
        if (wait) {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          cancelled += 1;
          cancellations.emit('cancelled');
          process.stderr.write('aborted\n');
          return 'aborted';
        }
        return 'finished';
      },
    }),
    defineMcpTool({
      name: 'cancelled',
      description: 'Answer once the slow tool has seen this many cancellations.',
      input: z.object({ count: z.number().int() }),
      access: open,
      handler: async ({ count }, ctx) => {
        while (cancelled < count) {
          await once(cancellations, 'cancelled', { signal: ctx.signal });
        }
        return String(cancelled);
      },
    }),
  ],
});

await serveMcpStdio(server, {
  maxInputRounds: 3,
  onError: (error) => {
    process.stderr.write(`${error.code}\n`);
  },
});
process.stderr.write('closed\n');
