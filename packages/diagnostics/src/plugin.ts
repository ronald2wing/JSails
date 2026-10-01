/**
 * The `diagnostics` plugin: exposes a {@link Diagnostics} service under a
 * typed service token.
 *
 * `diagnosticsPlugin({ recorder?, enabled? })` defines a {@link JsailsPlugin}
 * named `diagnostics` whose `setup` provides the service under
 * {@link diagnosticsToken}:
 *
 * - with an explicit `recorder`, that recorder is used verbatim (identity
 *   preserved) and the plugin never closes it;
 * - otherwise the plugin owns the zero-config
 *   {@link InMemoryDiagnosticsRecorder} (1000-entry default);
 * - when `enabled` is `false`, the plugin still registers the service, but the
 *   service is a no-op: every call returns static empty/zero values.
 *
 * Construction is inert: nothing connects and no entry is recorded until the
 * service's `record`/`entries`/`stats` is called. Cleanup is a no-op, so the
 * runner's `close` stays idempotent.
 */

import { diagnosticsToken, type Diagnostics, type DiagnosticsRecorder } from 'jsails/diagnostics';
import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { isRecord } from 'jsails/plugin-sdk';
import { InMemoryDiagnosticsRecorder } from './recorder.js';

/** Options accepted by {@link diagnosticsPlugin}. */
export interface DiagnosticsPluginOptions {
  /** Caller-provided recorder; used verbatim and never closed by the plugin. */
  readonly recorder?: DiagnosticsRecorder;
  /**
   * When `false`, the service is a no-op that records nothing. The plugin
   * still registers the service (so consumers that `require` the token never
   * fail), but every call returns static empty/zero values. Defaults to
   * `true`.
   */
  readonly enabled?: boolean;
}

/** The methods every {@link DiagnosticsRecorder} must expose. */
const RECORDER_METHODS = ['record', 'entries', 'clear', 'stats', 'wrapAsync'] as const;

/** Whether `value` has the {@link DiagnosticsRecorder} surface. */
function isRecorder(value: unknown): value is DiagnosticsRecorder {
  return isRecord(value) && RECORDER_METHODS.every((method) => typeof value[method] === 'function');
}

/** A no-op `Diagnostics` service, provided when `enabled` is `false`. */
function noopDiagnostics(): Diagnostics {
  return {
    record: () => {},
    entries: () => [],
    clear: () => {},
    stats: () => ({ total: 0, byType: {}, withDuration: 0 }),
  };
}

/**
 * Define the `diagnostics` plugin. Validation is eager and throws `TypeError`
 * for malformed options; the returned plugin is otherwise inert and opens no
 * connection.
 */
export function diagnosticsPlugin(options: DiagnosticsPluginOptions = {}): JsailsPlugin {
  const raw: unknown = options;
  if (!isRecord(raw)) {
    throw new TypeError('diagnosticsPlugin requires an options object');
  }
  if (options.recorder !== undefined && !isRecorder(options.recorder)) {
    throw new TypeError('recorder must be a diagnostics recorder');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }

  return definePlugin({
    name: 'diagnostics',
    setup({ services }) {
      if (options.enabled === false) {
        services.provide(diagnosticsToken, noopDiagnostics());
        return;
      }
      services.provide(diagnosticsToken, options.recorder ?? new InMemoryDiagnosticsRecorder());
    },
  });
}
