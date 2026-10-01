/** Types of `index.mjs`, for the TypeScript suites that load the collectors. */

/** The diagnostics channels the framework publishes request work on. */
export declare const CHANNELS: Readonly<{
  render: 'jsails:render';
  hash: 'jsails:hash';
  store: 'jsails:store';
}>;

/** A scalar counter name. */
export type CounterName =
  | 'fs'
  | 'zlib'
  | 'promises'
  | 'responses'
  | 'readableStreams'
  | 'bodyStreams'
  | 'alsRuns'
  | 'modules'
  | 'hashes'
  | 'renders'
  | 'stores';

/** Every scalar counter, in report order. */
export declare const COUNTERS: readonly CounterName[];

/** Counter values; `fsCalls` splits `fs` by function (`fs.statSync`, `fs/promises.open`). */
export type Counts = Record<CounterName, number> & {
  readonly fsCalls: Readonly<Record<string, number>>;
};

/** The process's installed counters. */
export interface Collectors {
  read(): Counts;
  reset(): void;
  mark(name: string): void;
  marked(name: string): boolean;
  since(name: string): Counts;
  measure<T>(fn: () => T | Promise<T>): Promise<{ result: T; counts: Counts }>;
  /** Wrap a `Response`/`ReadableStream` global that replaced the wrapped one; the names wrapped. */
  adoptGlobals(): readonly ('Response' | 'ReadableStream')[];
  uninstall(): void;
}

/** Raised when the collectors are misused. */
export declare class CollectorError extends Error {
  readonly code: 'collectors_installed' | 'collectors_uninstalled' | 'unknown_mark';
}

/** Patch this process once and return its counters. */
export declare function installCollectors(): Collectors;
