/**
 * The `diagnostics` plugin: exposes a {@link Diagnostics} service under
 * {@link diagnosticsToken}.
 *
 * `diagnosticsPlugin(options?)` configures a plugin named `diagnostics` on the
 * `definePlugin` contract. Its options are data and callbacks, checked by a
 * strict schema when the factory is called (a failure is
 * `config.invalid_options`, before anything runs):
 *
 * - the recorder options (`maxEntries`, `clock`, `tags`, `monitored`,
 *   `filters`) configure the plugin-owned {@link InMemoryDiagnosticsRecorder};
 * - `enabled: false` provides a no-op service instead: consumers that require
 *   the token still run, and every call returns static empty values.
 *
 * Options hold no instances, so there is no recorder option: an application
 * that brings its own recorder provides `diagnosticsToken` from its own plugin.
 * Setup constructs the recorder, which opens nothing and records nothing until
 * the service is called, and returns no cleanup.
 */

import {
  diagnosticsToken,
  type DiagnosticsEntry,
  type Diagnostics,
  type DiagnosticsFilterFn,
  type TagCallback,
} from 'jsails/diagnostics';
import { definePlugin, fn, type PluginFactory } from 'jsails/kernel';
import { z } from 'jsails/zod';

import { InMemoryDiagnosticsRecorder } from './recorder.js';

/**
 * Options accepted by {@link diagnosticsPlugin}.
 *
 * @public
 */
export interface DiagnosticsPluginOptions {
  /**
   * When `false`, the service is a no-op that records nothing. The plugin
   * still registers the service (so consumers that `require` the token never
   * fail), but every call returns static empty/zero values. Defaults to
   * `true`.
   */
  readonly enabled?: boolean;
  /** Entries the recorder holds before the oldest is evicted. Defaults to 1000. */
  readonly maxEntries?: number;
  /** Clock returning milliseconds since epoch. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Tag callbacks that derive per-entry tags at record time. */
  readonly tags?: readonly TagCallback[];
  /** Tag names whose entries are counted in the stats' `monitoredCounts`. */
  readonly monitored?: readonly string[];
  /** A record-time gate and a read-time transform of `entries()`. */
  readonly filters?: {
    readonly filter?: DiagnosticsFilterFn;
    readonly filterBatch?: (entries: readonly DiagnosticsEntry[]) => DiagnosticsEntry[];
  };
}

const diagnosticsOptions: z.ZodType<DiagnosticsPluginOptions> = z
  .object({
    enabled: z.boolean().optional(),
    maxEntries: z.number().int().min(1).max(1_000_000).optional(),
    clock: fn<() => number>().optional(),
    tags: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            when: fn<TagCallback['when']>(),
            value: fn<TagCallback['value']>(),
          })
          .strict(),
      )
      .optional(),
    monitored: z.array(z.string().min(1).max(200)).optional(),
    filters: z
      .object({
        filter: fn<DiagnosticsFilterFn>().optional(),
        filterBatch: fn<(entries: readonly DiagnosticsEntry[]) => DiagnosticsEntry[]>().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
 * The `diagnostics` plugin. Nothing is constructed until its setup runs,
 * which provides the service under {@link diagnosticsToken}.
 */
export const diagnosticsPlugin: PluginFactory<DiagnosticsPluginOptions | undefined> = definePlugin({
  name: 'diagnostics',
  options: diagnosticsOptions.optional(),
  provides: [diagnosticsToken],
  setup({ options, services }) {
    if (options?.enabled === false) {
      services.provide(diagnosticsToken, noopDiagnostics());
      return;
    }
    services.provide(
      diagnosticsToken,
      new InMemoryDiagnosticsRecorder({
        maxEntries: options?.maxEntries,
        clock: options?.clock,
        tags: options?.tags,
        monitored: options?.monitored,
        filters: options?.filters,
      }),
    );
  },
});
