/**
 * The `@jsails/diagnostics` package: the in-memory recorder, watchers,
 * exporters, and plugin behind the `jsails/diagnostics` contract
 * (`DiagnosticsRecorder`, `DiagnosticsEntry`, filters, tags, pruning options,
 * and `diagnosticsToken` live there).
 */

export { InMemoryDiagnosticsRecorder } from './recorder.js';
export { diagnosticsPlugin, type DiagnosticsPluginOptions } from './plugin.js';
export {
  consoleExporter,
  createHttpExporter,
  DiagnosticsExporterError,
  exportOnce,
  type ConsoleExporterOptions,
  type DiagnosticsExporter,
  type DiagnosticsExporterErrorCode,
  type HttpExporterOptions,
} from './exporters.js';
export {
  createWatcherRegistry,
  WatcherError,
  type Watcher,
  type WatcherContext,
  type WatcherErrorCode,
  type WatcherRegistry,
} from './watchers/registry.js';
export { RequestWatcher, type RequestWatcherOptions } from './watchers/request.js';
export { QueryWatcher, type QueryEvent, type QueryWatcherOptions } from './watchers/query.js';
export {
  ExceptionWatcher,
  type CapturedError,
  type CapturedErrorHandler,
  type ErrorSubscribe,
  type ExceptionWatcherOptions,
} from './watchers/exception.js';
export { createTagRegistry, type TagRegistry } from './tags.js';
export { applyFilters } from './filters.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { diagnosticsPlugin as default } from './plugin.js';
