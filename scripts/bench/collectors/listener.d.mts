/** Types of `listener.mjs`, for the TypeScript suites that drive a request listener. */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A `node:http` request listener. */
export type RequestListener = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Options of {@link driveListener}. */
export interface DriveOptions {
  /** Destroy the socket once this many body chunks have arrived, as a client that disconnects. */
  readonly abortAfterChunks?: number;
  /** Called with `n` as the n-th body chunk reaches the socket. */
  readonly onChunk?: (count: number) => void;
  /** Milliseconds to wait for the response to finish; 5000 by default. */
  readonly timeoutMs?: number;
}

/**
 * The body data one socket write carried (chunked coding removed), with the
 * time it reached the socket since the request started.
 */
export interface ListenerChunk {
  readonly bytes: Uint8Array;
  readonly at: number;
}

/** What a client received, and how the listener wrote it. */
export interface ListenerResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly rawHeaders: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  text(): string;
  readonly chunks: readonly ListenerChunk[];
  /** `res.write` calls that carried data. */
  readonly writes: number;
  /** Whether `res.end` carried the (last part of the) body: the direct path. */
  readonly endedWithBody: boolean;
  /** Whether `abortAfterChunks` destroyed the socket. */
  readonly aborted: boolean;
  /** The error the listener destroyed the socket with, when it did. */
  readonly error: string | undefined;
}

/** Raised when a driven request does not finish. */
export declare class ListenerDriverError extends Error {
  readonly code: 'listener_timeout';
}

/** Drive `request` through `listener` over an in-memory socket. */
export declare function driveListener(
  listener: RequestListener,
  request: Request,
  options?: DriveOptions,
): Promise<ListenerResult>;
