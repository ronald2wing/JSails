/**
 * Diagnostics contract (`jsails/diagnostics`): entry/stat types, the recorder
 * interface, the `Diagnostics` service, and its typed token.
 *
 * The in-memory recorder, watchers, exporters, and plugin live in
 * `@jsails/diagnostics`.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';

/** A single recorded diagnostic entry, immutable after recording. */
export interface DiagnosticsEntry {
  /** Entry type (e.g. "http", "query", "job", "broadcast"). */
  readonly type: string;
  /** Milliseconds since epoch when the entry was recorded. */
  readonly at: number;
  /**
   * Monotonic entry identifier derived by the recorder. Never caller-supplied;
   * rendered as the decimal string `"<n>"`.
   */
  readonly id?: string;
  /**
   * Stable 12-hex-char hash of `type` + {@link data}`.family`, derived by the
   * recorder when a `family` discriminator is present. Omitted otherwise.
   */
  readonly familyHash?: string;
  /** Wall-clock duration in milliseconds, when {@link wrapAsync} recorded it. */
  readonly durationMs?: number;
  /** Value-free metadata; never contains secrets, credentials, or raw bodies. */
  readonly data?: Readonly<Record<string, unknown>>;
  /**
   * Tags derived from {@link DiagnosticsRecorderOptions.tags} callbacks at
   * record time. Each tag is a `"name:value"` string; omitted when no
   * callbacks matched or no callbacks were configured.
   */
  readonly tags?: readonly string[];
}

/**
 * Filter for {@link InMemoryDiagnosticsRecorder.entries}. An omitted filter returns
 * every entry; a single type matches that string; an array matches any listed
 * type.
 */
export interface DiagnosticsFilter {
  readonly type?: string | readonly string[];
}

/** Aggregate statistics over the recorded entries. */
export interface DiagnosticsStats {
  /** Total entries currently in the buffer. */
  readonly total: number;
  /** Count of entries per type, keyed by type string. */
  readonly byType: Readonly<Record<string, number>>;
  /** How many entries carry a duration (i.e. were recorded via wrapAsync). */
  readonly withDuration: number;
  /**
   * Counts of entries whose tags intersect the {@link DiagnosticsRecorderOptions.monitored}
   * set, keyed by monitored tag name. Present only when `monitored` is set.
   */
  readonly monitoredCounts?: Readonly<Record<string, number>>;
}

/** Options for {@link InMemoryDiagnosticsRecorder}. */
export interface DiagnosticsRecorderOptions {
  /**
   * Maximum entries the buffer holds before it wraps. When the buffer is full
   * the oldest entry is evicted. Defaults to 1000.
   */
  readonly maxEntries?: number;
  /**
   * Monotonic clock returning milliseconds since epoch. Defaults to
   * {@link Date.now}. Inject a fake clock in tests.
   */
  readonly clock?: () => number;
  /**
   * Tag callbacks that derive per-entry tags at record time. A callback that
   * throws is skipped for that entry — tags must never break recording.
   */
  readonly tags?: readonly TagCallback[];
  /** Tag names whose entries are counted in {@link DiagnosticsStats.monitoredCounts}. */
  readonly monitored?: readonly string[];
  /**
   * Filters to gate recording and transform `entries()` output.
   * `filter` drops an entry at record time (fail-closed). `filterBatch` is a
   * read-time transform applied after the type filter on `entries()`.
   */
  readonly filters?: DiagnosticsFilters;
  /**
   * Whether the recorder starts actively recording. When `false` the recorder
   * is constructed silent (record/wrapAsync are no-ops) but {@link isPaused}
   * returns `false`. Call {@link resume} to enable recording. Defaults to
   * `true`.
   */
  readonly enabled?: boolean;
}

/**
 * A bounded, in-memory recorder of diagnostic entries with typed filtering
 * and aggregate statistics. Every entry is value-free — no raw secrets,
 * credentials, or environment data is recorded.
 */
export interface DiagnosticsRecorder {
  /** Record a new entry (derives `at` from the clock). */
  record(entry: Omit<DiagnosticsEntry, 'at'>): void;
  /** Return recorded entries, filtered by type when `filter.type` is set. */
  entries(filter?: DiagnosticsFilter): DiagnosticsEntry[];
  /** Discard every recorded entry. */
  clear(): void;
  /** Aggregate counts: total, per-type, and how many carry a duration. */
  stats(): DiagnosticsStats;
  /**
   * Wrap an async call, recording its duration and outcome. The entry type is
   * prefixed with `"failed:"` when `fn` throws or rejects, and the error is
   * rethrown so the caller still sees it.
   */
  wrapAsync<T>(type: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Pause recording: `record` and `wrapAsync` become no-ops for new entries.
   * Existing entries, `entries()`, `stats()`, and `clear()` still work.
   * Idempotent.
   */
  pause(): void;
  /**
   * Resume recording after a pause. Also re-enables the recorder when it was
   * constructed with `enabled: false`. Idempotent.
   */
  resume(): void;
  /** Whether the recorder is currently paused via {@link pause}. */
  isPaused(): boolean;
  /**
   * Prune entries in place, returning the count of removed entries.
   * `now` defaults to the recorder's clock.
   */
  prune(options: PruneOptions, now?: number): number;
}

/** A record-time predicate that gates whether an entry is kept. */
export type DiagnosticsFilterFn = (entry: DiagnosticsEntry) => boolean;

/** Record-time and read-time filter callbacks. */
export interface DiagnosticsFilters {
  /**
   * Per-entry gate called at record time. Returning `false` drops the entry
   * before it reaches the buffer. A throwing filter is treated as fail-closed
   * (drop) so a broken filter never leaks entries.
   */
  readonly filter?: DiagnosticsFilterFn;
  /**
   * Read-time transform applied to the result of `entries()`, after the type
   * filter. The returned array becomes the final output. A throwing filter
   * propagates to the caller (entries() does not guard it).
   */
  readonly filterBatch?: (entries: readonly DiagnosticsEntry[]) => DiagnosticsEntry[];
}

/** A named tag callback that labels an entry when its `when` predicate matches. */
export interface TagCallback {
  readonly name: string;
  readonly when: (entry: DiagnosticsEntry) => boolean;
  readonly value: (entry: DiagnosticsEntry) => string;
}

/** Options for {@link pruneEntries}. */
export interface PruneOptions {
  /** Drop entries whose `at` is older than this many hours before `now`. */
  readonly hours: number;
  /** Always keep at least this many newest 'exception' entries regardless of age. */
  readonly keepExceptions: number;
}

/**
 * The service the `diagnostics` plugin provides. It mirrors
 * {@link DiagnosticsRecorder} exactly except `wrapAsync` is excluded — the
 * recorder's `wrapAsync` is a utility available at the module level, not a
 * service capability. Consumers who need `wrapAsync` import it from the
 * recorder module directly.
 */
export interface Diagnostics {
  /** Record a new entry (derives `at` from the clock). */
  record(entry: Omit<DiagnosticsEntry, 'at'>): void;
  /** Return recorded entries, filtered by type when `filter.type` is set. */
  entries(filter?: DiagnosticsFilter): DiagnosticsEntry[];
  /** Discard every recorded entry. */
  clear(): void;
  /** Aggregate counts: total, per-type, and how many carry a duration. */
  stats(): DiagnosticsStats;
}

/**
 * Opaque token for the application {@link Diagnostics}. Defined once here and
 * shared by the provider (`diagnosticsPlugin`) and any consumer (e.g. an
 * extension's `requires`).
 */
export const diagnosticsToken: ServiceToken<Diagnostics> =
  createServiceToken<Diagnostics>('diagnostics');
