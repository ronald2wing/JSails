/**
 * {@link InMemoryDiagnosticsRecorder}: a bounded ring buffer of typed,
 * value-free {@link DiagnosticsEntry} instances.
 *
 * Entries are held in-process, the buffer is bounded so it never grows without
 * limit, and entry data is a plain record — no secrets, no credentials, no raw
 * request bodies or environment values. `wrapAsync(type, fn)` is the primary
 * integration seam: it wraps an async call, records its duration, and rethrows
 * the error so a watcher can observe the failure without swallowing it.
 */

import type {
  DiagnosticsEntry,
  DiagnosticsFilter,
  DiagnosticsRecorder,
  DiagnosticsRecorderOptions,
  DiagnosticsStats,
  PruneOptions,
} from 'jsails/diagnostics';
import { isRecord } from 'jsails/plugin-sdk';
import { deriveFamilyHash } from './family-hash.js';
import { applyFilters } from './filters.js';
import { pruneEntries } from './prune.js';
import { createTagRegistry, type TagRegistry } from './tags.js';

const DEFAULT_MAX_ENTRIES = 1000;

/** Validate construction options eagerly; a malformed option is a `TypeError`. */
function assertOptions(options: DiagnosticsRecorderOptions): void {
  if (options.maxEntries !== undefined) {
    if (typeof options.maxEntries !== 'number' || !Number.isFinite(options.maxEntries)) {
      throw new TypeError('maxEntries must be a finite number');
    }
    if (options.maxEntries < 1 || !Number.isInteger(options.maxEntries)) {
      throw new TypeError('maxEntries must be a positive integer');
    }
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }
}

/** Whether the entry's type is selected by a read filter. */
function typeMatches(entry: DiagnosticsEntry, filterType: DiagnosticsFilter['type']): boolean {
  if (filterType === undefined) {
    return true;
  }
  return typeof filterType === 'string'
    ? entry.type === filterType
    : filterType.includes(entry.type);
}

/** The tag name of a `"name:value"` tag. */
function tagName(tag: string): string {
  const separator = tag.indexOf(':');
  return separator === -1 ? tag : tag.slice(0, separator);
}

/**
 * A bounded, in-memory diagnostics recorder. Construction is inert — the
 * buffer is allocated but no I/O, connection, or timer is opened.
 */
export class InMemoryDiagnosticsRecorder implements DiagnosticsRecorder {
  // Pre-allocated ring buffer: `#head` is the next write slot and `#count`
  // the number of live entries, so the oldest live entry is at `#head` once
  // the buffer has wrapped and at index 0 before that.
  readonly #buffer: (DiagnosticsEntry | undefined)[];
  #head = 0;
  #count = 0;
  #nextId = 1;

  // `enabled: false` starts the recorder silent without reporting it paused;
  // `resume()` lifts both.
  #disabled: boolean;
  #paused = false;

  readonly #maxEntries: number;
  readonly #clock: () => number;
  readonly #options: DiagnosticsRecorderOptions;
  readonly #tags: TagRegistry | undefined;

  constructor(options: DiagnosticsRecorderOptions = {}) {
    const raw: unknown = options;
    if (!isRecord(raw)) {
      throw new TypeError('options must be an object');
    }
    assertOptions(options);

    this.#options = options;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#clock = options.clock ?? Date.now;
    this.#disabled = options.enabled === false;
    this.#buffer = new Array<DiagnosticsEntry | undefined>(this.#maxEntries);
    this.#tags =
      options.tags !== undefined && options.tags.length > 0
        ? createTagRegistry(options.tags)
        : undefined;
  }

  record(entry: Omit<DiagnosticsEntry, 'at'>): void {
    if (this.#disabled || this.#paused) {
      return;
    }

    const family = entry.data?.family;
    const familyHash =
      typeof family === 'string' && family.length > 0
        ? deriveFamilyHash(entry.type, family)
        : undefined;
    const untagged: DiagnosticsEntry = {
      type: entry.type,
      at: this.#clock(),
      id: String(this.#nextId++),
      ...(familyHash !== undefined ? { familyHash } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    };

    // Tags are derived from the complete entry (a throwing callback is
    // skipped), then the record-time filter sees the tagged entry and drops it
    // fail-closed when the filter throws.
    const tags = this.#tags?.tag(untagged);
    const complete = tags !== undefined && tags.length > 0 ? { ...untagged, tags } : untagged;
    if (this.#options.filters !== undefined && !applyFilters(complete, this.#options.filters)) {
      return;
    }

    this.#push(complete);
  }

  entries(filter: DiagnosticsFilter = {}): DiagnosticsEntry[] {
    const result = this.#liveEntries().filter((entry) => typeMatches(entry, filter.type));
    const filterBatch = this.#options.filters?.filterBatch;
    return filterBatch === undefined ? result : filterBatch(result);
  }

  clear(): void {
    this.#buffer.fill(undefined);
    this.#head = 0;
    this.#count = 0;
  }

  stats(): DiagnosticsStats {
    const monitored = this.#options.monitored;
    const byType: Record<string, number> = {};
    const monitoredCounts: Record<string, number> = {};
    let withDuration = 0;

    const all = this.entries();
    for (const entry of all) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      if (entry.durationMs !== undefined) {
        withDuration += 1;
      }
      if (monitored !== undefined && entry.tags !== undefined) {
        const names = new Set(entry.tags.map(tagName));
        for (const name of monitored) {
          if (names.has(name)) {
            monitoredCounts[name] = (monitoredCounts[name] ?? 0) + 1;
          }
        }
      }
    }

    return monitored === undefined
      ? { total: all.length, byType, withDuration }
      : { total: all.length, byType, withDuration, monitoredCounts };
  }

  async wrapAsync<T>(type: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.#clock();
    try {
      const result = await fn();
      this.record({ type, durationMs: this.#clock() - startedAt, data: { status: 'success' } });
      return result;
    } catch (error) {
      this.record({
        type: `failed:${type}`,
        durationMs: this.#clock() - startedAt,
        data: { status: 'failure' },
      });
      throw error;
    }
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.#disabled = false;
  }

  isPaused(): boolean {
    return this.#paused;
  }

  prune(options: PruneOptions, now?: number): number {
    // Pruning reads the raw buffer, bypassing the read-time filters.
    const all = this.#liveEntries();
    const retained = pruneEntries(all, options, now ?? this.#clock());
    const removed = all.length - retained.length;
    if (removed === 0) {
      return 0;
    }
    this.clear();
    for (const entry of retained) {
      this.#push(entry);
    }
    return removed;
  }

  /** Append one entry, overwriting the oldest slot once the buffer is full. */
  #push(entry: DiagnosticsEntry): void {
    this.#buffer[this.#head] = entry;
    this.#head = (this.#head + 1) % this.#maxEntries;
    if (this.#count < this.#maxEntries) {
      this.#count += 1;
    }
  }

  /** The live entries, oldest first, walking the ring from its oldest slot. */
  #liveEntries(): DiagnosticsEntry[] {
    const start = this.#count === this.#maxEntries ? this.#head : 0;
    const result: DiagnosticsEntry[] = [];
    for (let i = 0; i < this.#count; i++) {
      const entry = this.#buffer[(start + i) % this.#maxEntries];
      if (entry !== undefined) {
        result.push(entry);
      }
    }
    return result;
  }
}
