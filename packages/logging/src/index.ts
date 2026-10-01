/**
 * The `@jsails/logging` package: a record-first structured logging service.
 *
 * The record is the API and the string is a rendering: a {@link Logger} call
 * builds a frozen {@link LogRecord}, and each {@link LogChannel} receives the
 * record and renders it with a {@link LogFormatter} if it needs text. The
 * barrel exports the contract, the level vocabulary, the built-in channels and
 * formatters, {@link RecordLogger}, and the plugin with its service token.
 */

export {
  logError,
  type LogChannel,
  type LogFormatter,
  type Logger,
  type LogRecord,
} from './contract.js';
export type { LogLevel } from './levels.js';
export {
  consoleChannel,
  memoryChannel,
  nullChannel,
  type ConsoleChannelOptions,
  type MemoryChannel,
  type MemoryChannelOptions,
} from './channels.js';
export { jsonFormatter, lineFormatter } from './formatters.js';
export { RecordLogger, type LoggerOptions } from './logger.js';
export { loggingPlugin, loggingToken, type LoggingPluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { loggingPlugin as default } from './plugin.js';
