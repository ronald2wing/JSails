/**
 * The `logging` plugin: exposes a {@link Logger} service under
 * {@link loggingToken}.
 *
 * Construction is inert — no I/O, no `process` access, no connection until a
 * log method is called. Options are passed through to {@link RecordLogger} and
 * validated eagerly during `setup`, so invalid options throw `TypeError` there
 * rather than silently degrading. Cleanup is a no-op, so the runner's `close`
 * stays idempotent.
 */

import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';
import type { Logger } from './contract.js';
import { RecordLogger, type LoggerOptions } from './logger.js';

/**
 * Opaque token for the application {@link Logger}, shared by the provider and
 * any consumer (e.g. an extension's `requires`).
 */
export const loggingToken: ServiceToken<Logger> = createServiceToken<Logger>('logging');

/** Options accepted by {@link loggingPlugin}: the {@link RecordLogger} options. */
export type LoggingPluginOptions = LoggerOptions;

/** Define the `logging` plugin. */
export function loggingPlugin(options?: LoggingPluginOptions): JsailsPlugin {
  return definePlugin({
    name: 'logging',
    setup({ services }) {
      services.provide(loggingToken, new RecordLogger(options));
    },
  });
}
