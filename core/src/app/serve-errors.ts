/**
 * The server lifecycle's codes, `serve.*`, in a module of their own so an app
 * can recognize them (`ServeErrors.is(error, 'shutdown_timeout')`) without
 * loading the server (`serve.ts` is imported only when an application
 * serves).
 */

import { defineErrors, type ErrorRegistry, type Payload } from '../errors/registry.js';

const SERVE_ERRORS = {
  invalid_attachment: {
    kind: 'internal',
    message: 'a serve hook of {owner} returned something other than a drain participant or nothing',
    context: { owner: 'identifier' },
    suggestion:
      'return nothing, or a ServeAttachment: an identifier name and a drain(deadline) function',
  },
  missing_attachment: {
    kind: 'internal',
    message:
      'a serve hook of {owner} listens for upgrades but returned no drain participant to close them',
    context: { owner: 'identifier' },
    suggestion:
      'return a ServeAttachment whose drain disconnects the upgraded sockets the hook accepts',
  },
  invalid_handle: {
    kind: 'internal',
    message: 'the listen handle is not a listening TCP handle or file descriptor',
    suggestion:
      'pass the native handle a supervisor sent over IPC (server._handle), or { fd } of a listening TCP socket',
  },
  unsupported_platform: {
    kind: 'internal',
    message: 'listening on a passed handle is not supported on Windows',
    context: { platform: ['win32'] },
    suggestion:
      'listen on config.host and config.port; Windows is supported for development, so run a supervisor that passes handles on Linux or macOS',
  },
  draining: {
    kind: 'aborted',
    message: 'the server is draining for shutdown',
  },
  stopped: {
    kind: 'aborted',
    message: 'the server stopped at its shutdown deadline',
  },
  unfinished_stream: {
    kind: 'timeout',
    message: 'a streamed response was still open at the shutdown deadline',
    suggestion:
      'declare a stream that never ends live (Respond.eventStream, or Respond.stream with { live: true }); a finite stream must end within shutdownTimeoutMs',
  },
  shutdown_timeout: {
    kind: 'timeout',
    message:
      'the server did not drain before its shutdown deadline: {attachments} drain participants, {streams} streams, {requests} other requests and {connections} connections ({upgraded} upgraded) were still open',
    context: {
      attachments: 'count',
      streams: 'count',
      requests: 'count',
      connections: 'count',
      upgraded: 'count',
    },
    suggestion:
      'declare endless streams live, let handlers observe ctx.signal, or raise shutdownTimeoutMs',
    payload: {} as Payload<{ readonly attachments: readonly string[] }>,
  },
} as const;

/**
 * The server lifecycle's codes, `serve.*`: a serve hook that returned
 * something other than a drain participant, or listens for upgrades without
 * one; a listen handle that is not a listening TCP handle, or any handle on
 * Windows, which has no listening descriptors to pass; the abort reasons a
 * shutdown gives a live answer (`draining`) and every request still running at
 * the deadline (`stopped`); a stream still open at the deadline (reported
 * through its request); and a drain that passed its deadline
 * (`shutdown_timeout`, which `close()` rejects with: its payload names the
 * participants still draining).
 *
 * @public
 */
export const ServeErrors: ErrorRegistry<'serve', typeof SERVE_ERRORS> = defineErrors(
  'serve',
  SERVE_ERRORS,
);
