/**
 * Keeps a stdio MCP server's stdout for protocol frames only.
 *
 * Over stdio, stdout is the JSON-RPC channel: one stray line from a config
 * module's `console.log` corrupts the stream the client parses. The guard is
 * installed before any app module is imported and does two things:
 *
 * - every `console` method is rebound to a console that writes both streams
 *   to stderr, so logging from app code keeps working and lands where the
 *   client shows server logs;
 * - `stdout.write` itself is diverted to stderr, which catches code that
 *   writes to `process.stdout` directly.
 *
 * The transport receives {@link StdoutGuard.frames}, a writable bound to the
 * original `write`, so protocol frames are the only bytes that reach stdout.
 * A write through a raw file descriptor (`fs.writeSync(1, ...)`) is outside
 * what a JavaScript-level guard can see.
 */

import { Console } from 'node:console';
import { Writable } from 'node:stream';

/** The streams and console a guard takes over. Defaults: the process's own. */
export interface StdoutGuardTargets {
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly console?: Console;
}

/** An installed guard. */
export interface StdoutGuard {
  /** The only writer that reaches the real stdout: give it to the transport. */
  readonly frames: Writable;
  /** Put the console and `stdout.write` back as they were. Idempotent. */
  restore(): void;
}

/**
 * Install the guard. Call it before importing any module whose top-level code
 * may write to stdout.
 */
export function guardStdout(targets: StdoutGuardTargets = {}): StdoutGuard {
  const stdout: Writable = targets.stdout ?? process.stdout;
  const stderr: Writable = targets.stderr ?? process.stderr;
  const target = targets.console ?? console;

  const redirected = new Console({ stdout: stderr, stderr });
  const savedConsole = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of Reflect.ownKeys(redirected)) {
    const method: unknown = Reflect.get(redirected, key);
    if (typeof method !== 'function') {
      continue;
    }
    savedConsole.set(key, Object.getOwnPropertyDescriptor(target, key));
    Object.defineProperty(target, key, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  const ownWrite = Object.getOwnPropertyDescriptor(stdout, 'write');
  const originalWrite = stdout.write.bind(stdout);
  Object.defineProperty(stdout, 'write', {
    value: stderr.write.bind(stderr),
    writable: true,
    configurable: true,
    enumerable: false,
  });

  const frames = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      originalWrite(chunk, (error) => {
        callback(error ?? null);
      });
    },
  });
  // A broken pipe also surfaces as an 'error' event on stdout itself; route it
  // to the frame writer (whose owner is listening) instead of crashing.
  const onStdoutError = (error: Error): void => {
    frames.destroy(error);
  };
  stdout.on('error', onStdoutError);

  let restored = false;
  return Object.freeze({
    frames,
    restore(): void {
      if (restored) {
        return;
      }
      restored = true;
      stdout.off('error', onStdoutError);
      if (ownWrite === undefined) {
        Reflect.deleteProperty(stdout, 'write');
      } else {
        Object.defineProperty(stdout, 'write', ownWrite);
      }
      for (const [key, descriptor] of savedConsole) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(target, key);
        } else {
          Object.defineProperty(target, key, descriptor);
        }
      }
    },
  });
}
