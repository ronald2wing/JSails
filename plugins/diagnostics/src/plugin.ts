/**
 * First-party `diagnostics` plugin: exposes a {@link Diagnostics} service under
 * a typed service token.
 *
 * `diagnosticsPlugin({ recorder?, enabled? })` builds a {@link JsailsPlugin}
 * named `diagnostics` whose `setup` provides the service under
 * {@link diagnosticsToken}:
 *
 * - with an explicit `recorder`, that recorder is used verbatim (identity
 *   preserved) and the plugin never closes it;
 * - otherwise the plugin owns the zero-config
 *   {@link InMemoryDiagnosticsRecorder} (1000-entry default).
 * - when `enabled` is `false`, the plugin still registers the service, but the
 *   service is a no-op: every call returns static empty/zero values and
 *   `wrapAsync` passes through without recording.
 *
 * Construction is inert: nothing connects and no entry is recorded until the
 * service's `record`/`entries`/`stats`/`wrapAsync` is called. Cleanup is a
 * no-op, so the runner's `close` stays idempotent.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { type Diagnostics, diagnosticsToken, type DiagnosticsRecorder } from 'jsails/diagnostics';
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

/** True when `value` implements the {@link DiagnosticsRecorder} contract. */
function isRecorder(value: unknown): value is DiagnosticsRecorder {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<DiagnosticsRecorder>;
  return (
    typeof candidate.record === 'function' &&
    typeof candidate.entries === 'function' &&
    typeof candidate.clear === 'function' &&
    typeof candidate.stats === 'function' &&
    typeof candidate.wrapAsync === 'function'
  );
}

/** A no-op `Diagnostics` service returned when `enabled` is `false`. */
function noopDiagnostics(): Diagnostics {
  return {
    record: () => {},
    entries: () => [],
    clear: () => {},
    stats: () => ({ total: 0, byType: {}, withDuration: 0 }),
  };
}

/**
 * Build the first-party `diagnostics` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert
 * and opens no connection.
 */
export function diagnosticsPlugin(options: DiagnosticsPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
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
      // Use the caller-provided recorder verbatim, or own the default.
      services.provide(diagnosticsToken, options.recorder ?? new InMemoryDiagnosticsRecorder());
    },
  });
}
