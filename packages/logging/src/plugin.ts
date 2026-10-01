/**
 * The `logging` plugin: exposes a {@link Logger} service under
 * {@link loggingToken}.
 *
 * `loggingPlugin(options?)` configures a plugin named `logging` on the
 * `definePlugin` contract. Its options are data, callbacks and service
 * tokens, checked by a strict schema when the factory is called (a failure is
 * `config.invalid_options`, before anything runs):
 *
 * - `channels` are `{ name, minLevel, write }` objects (the built-in
 *   `consoleChannel()`, `memoryChannel()` and `nullChannel()`, or an
 *   application's own class instance); the logger keeps each one's `write`
 *   bound to the caller's channel, so a memory channel still sees every
 *   record and a `write` that reads `this` (a private field, a stream) still
 *   reaches its own state;
 * - `clock`, `redact` and `diagnosticsLevel` configure the {@link RecordLogger};
 * - `diagnostics` names the diagnostics service (`diagnosticsToken`) and
 *   `signals` the signal bus (`signalsToken`) the logger records into and
 *   emits {@link logError} on; each named token is required, so the plugin
 *   providing it runs first.
 *
 * Setup constructs the logger, which does no I/O until a log method is called,
 * and returns no cleanup.
 */

import { diagnosticsToken, type Diagnostics } from 'jsails/diagnostics';
import {
  boundObject,
  createServiceToken,
  definePlugin,
  fn,
  tokenRef,
  type PluginFactory,
  type ServiceToken,
} from 'jsails/kernel';
import { signalsToken, type SignalBus } from 'jsails/signals';
import { z } from 'jsails/zod';

import type { LogChannel, Logger, LogRecord } from './contract.js';
import { LEVEL_ORDER, type LogLevel } from './levels.js';
import { RecordLogger } from './logger.js';

/**
 * Opaque token for the application {@link Logger}, shared by the provider and
 * any consumer (e.g. an extension's `requires`).
 */
export const loggingToken: ServiceToken<Logger> = createServiceToken<Logger>('logging');

/**
 * Options accepted by {@link loggingPlugin}.
 *
 * @public
 */
export interface LoggingPluginOptions {
  /** Channels written on every log call, each filtering by its own `minLevel`. Default: one console channel. */
  readonly channels?: readonly LogChannel[];
  /** Clock returning milliseconds since epoch. Default: `Date.now`. */
  readonly clock?: () => number;
  /** The diagnostics service to record log entries into: `diagnosticsToken`. */
  readonly diagnostics?: ServiceToken<Diagnostics>;
  /** Lowest level recorded into `diagnostics`. Default: `'warn'`. */
  readonly diagnosticsLevel?: LogLevel;
  /** Context key endings whose values are redacted; `[]` turns redaction off. */
  readonly redact?: readonly string[];
  /** The signal bus `error` records emit `logError` on: `signalsToken`. */
  readonly signals?: ServiceToken<SignalBus>;
}

const logLevel = z.enum(Object.keys(LEVEL_ORDER) as [LogLevel, ...LogLevel[]]);

/**
 * A channel as the schema checks it: its `name`, `minLevel` and `write`, read
 * from the caller's object into a new plain object with `write` bound to the
 * caller's channel, so a class instance's method keeps its `this` (and its
 * private fields), and a channel's other keys (a memory channel's `records`)
 * stay on the caller's object.
 */
const channel = boundObject({
  name: z.string().min(1).max(200),
  minLevel: logLevel,
  write: fn<(record: LogRecord) => void>(),
});

const loggingOptions: z.ZodType<LoggingPluginOptions> = z
  .object({
    channels: z.array(channel).optional(),
    clock: fn<() => number>().optional(),
    diagnostics: tokenRef(diagnosticsToken).optional(),
    diagnosticsLevel: logLevel.optional(),
    redact: z.array(z.string().min(1).max(200)).optional(),
    signals: tokenRef(signalsToken).optional(),
  })
  .strict();

/**
 * The `logging` plugin. Nothing is constructed until its setup runs, which
 * provides the logger under {@link loggingToken}.
 */
export const loggingPlugin: PluginFactory<LoggingPluginOptions | undefined> = definePlugin({
  name: 'logging',
  options: loggingOptions.optional(),
  requires: (options) => [options?.diagnostics, options?.signals],
  provides: [loggingToken],
  setup({ options, services }) {
    services.provide(
      loggingToken,
      new RecordLogger({
        ...(options?.channels === undefined ? {} : { channels: options.channels }),
        ...(options?.clock === undefined ? {} : { clock: options.clock }),
        ...(options?.diagnosticsLevel === undefined
          ? {}
          : { diagnosticsLevel: options.diagnosticsLevel }),
        ...(options?.redact === undefined ? {} : { redact: options.redact }),
        ...(options?.diagnostics === undefined
          ? {}
          : { diagnostics: services.get(options.diagnostics) }),
        ...(options?.signals === undefined ? {} : { signals: services.get(options.signals) }),
      }),
    );
  },
});
