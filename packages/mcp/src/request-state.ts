/**
 * Sealing the multi-round-trip `requestState`.
 *
 * The state a handler asks to get back (and the framework's own confirmation
 * flags) travels through the client, so it comes back as attacker-controlled
 * input. The payload is encrypted with AES-256-GCM, so the client cannot read
 * it, and the ciphertext is wrapped in the SDK's `createRequestStateCodec`
 * envelope (HMAC-SHA256, expiry, constant-time verification, fixed opaque
 * failure reasons). Both keys are derived from the one serving key with HKDF,
 * under different labels.
 *
 * The binding pins a state to one place: the actor's kind and id, the
 * credential it presented, the method, the target (tool or prompt name,
 * resource URI), and a SHA-256 digest of the canonical JSON of the call's
 * arguments. It is the GCM additional data and, as an HMAC tag, part of the
 * envelope, so none of it is readable in the wire value. A state minted for
 * one caller, tool, or argument set fails for any other, as does an expired,
 * truncated, or edited one.
 *
 * A state is not single-use: nothing records that it was presented, so the
 * same caller can present it again, for the same call and arguments, until it
 * expires. That is the price of serving retries from any process without
 * shared storage; the TTL bounds it.
 *
 * The binding is computed by the serving layer, which knows the arguments,
 * and verified inside the request handlers rather than through the SDK's
 * `requestState.verify` hook, whose callback sees no request parameters. A
 * failure is answered with the same frozen `-32602 "Invalid or expired
 * requestState"` error the hook would produce.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import {
  createRequestStateCodec,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { isRecord } from 'jsails/plugin-sdk';

import type { McpActor } from './access.js';
import type { JsonValue } from './content.js';
import { McpDefinitionError } from './errors.js';

/** The methods whose results may ask for input. */
export type InputMethod = 'tools/call' | 'prompts/get' | 'resources/read';

/** Everything a sealed state is bound to. */
export interface StateBinding {
  readonly actor: McpActor;
  /** The credential the actor presented; `undefined` on transports without one. */
  readonly credential: string | undefined;
  readonly method: InputMethod;
  /** The tool or prompt name, or the resource URI. */
  readonly target: string;
  /** The call's arguments as sent; `undefined` for a resource read. */
  readonly args: unknown;
}

/** What a sealed state carries. */
export interface SealedPayload {
  /** The handler's own state. */
  readonly state?: JsonValue;
  /** The tool's confirmation was accepted in an earlier round. */
  readonly confirmed?: true;
  /** This round asked the tool's confirmation question, so the retry may answer it. */
  readonly confirmAsked?: true;
  /** How many input rounds this call has asked for so far (at least 1). */
  readonly rounds: number;
}

/** The most rounds a sealed state can record; serving options cap lower. */
export const MAX_SEALED_ROUNDS = 100;

/** The outcome of opening a state. */
export type OpenedState =
  | { readonly ok: true; readonly payload: SealedPayload }
  | { readonly ok: false; readonly reason: string };

/** Seals and opens request state under one key. */
export interface StateSeal {
  seal(payload: SealedPayload, binding: StateBinding, ctx: ServerContext): Promise<string>;
  open(state: string, binding: StateBinding, ctx: ServerContext): Promise<OpenedState>;
}

/** Options for {@link createStateSeal}. */
export interface StateSealOptions {
  /** At least 32 bytes; a fresh random key when omitted. */
  readonly key?: Uint8Array;
  /** How long a sealed state stays valid. Default 600 (ten minutes). */
  readonly ttlSeconds?: number;
}

const MIN_KEY_BYTES = 32;
const DEFAULT_TTL_SECONDS = 600;
const MAX_TTL_SECONDS = 86_400;
const BINDING_VERSION = 'jsails-mcp-state-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(master: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, new Uint8Array(0), label, 32));
}

/** `iv || ciphertext || tag`, base64url, with the binding as additional data. */
function encrypt(key: Buffer, plaintext: string, binding: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The plaintext of {@link encrypt}'s output, or `undefined` when it does not open. */
function decrypt(key: Buffer, sealed: unknown, binding: string): string | undefined {
  if (typeof sealed !== 'string') {
    return undefined;
  }
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.byteLength < IV_BYTES + TAG_BYTES) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(binding, 'utf8'));
    decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, bytes.byteLength - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch (_unauthentic) {
    return undefined;
  }
}

function parsed(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (_notJson) {
    return undefined;
  }
}

/**
 * Canonical JSON: object members sorted by key (UTF-16 code unit order),
 * `undefined` members dropped, arrays in order. Two values that are equal as
 * JSON produce the same text whatever their member order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** The SHA-256 digest (base64url) of the canonical JSON of `args`. */
export function argumentsDigest(args: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(args ?? null), 'utf8')
    .digest('base64url');
}

/**
 * The binding string. A JSON array, so no choice of component values can make
 * two different bindings serialize alike.
 */
export function bindingValue(binding: StateBinding): string {
  return JSON.stringify([
    BINDING_VERSION,
    binding.actor.kind,
    binding.actor.id ?? null,
    binding.credential ?? null,
    binding.method,
    binding.target,
    argumentsDigest(binding.args),
  ]);
}

/** The frozen error for a state that fails verification, worded as the SDK's own. */
export function invalidRequestState(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired requestState', {
    reason: 'invalid_request_state',
  });
}

const PAYLOAD_KEYS = new Set(['state', 'confirmed', 'confirmAsked', 'rounds']);

/** The payload the serving layer writes, checked, or `undefined` for anything else. */
export function checkPayload(value: unknown): SealedPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!PAYLOAD_KEYS.has(key)) {
      return undefined;
    }
  }
  if (value.confirmed !== undefined && value.confirmed !== true) {
    return undefined;
  }
  if (value.confirmAsked !== undefined && value.confirmAsked !== true) {
    return undefined;
  }
  const rounds = value.rounds;
  if (
    typeof rounds !== 'number' ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > MAX_SEALED_ROUNDS
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(value.state === undefined ? {} : { state: value.state as JsonValue }),
    ...(value.confirmed === true ? { confirmed: true as const } : {}),
    ...(value.confirmAsked === true ? { confirmAsked: true as const } : {}),
    rounds,
  });
}

/** Create a seal. Throws {@link McpDefinitionError} on a short key or a bad TTL. */
export function createStateSeal(options: StateSealOptions = {}): StateSeal {
  const key = options.key ?? randomBytes(MIN_KEY_BYTES);
  if (!(key instanceof Uint8Array) || key.byteLength < MIN_KEY_BYTES) {
    throw new McpDefinitionError(
      'invalid_option',
      `requestStateKey must be a Uint8Array of at least ${MIN_KEY_BYTES} bytes`,
      { option: 'requestStateKey' },
    );
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new McpDefinitionError(
      'invalid_option',
      `requestStateTtlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}`,
      { option: 'requestStateTtlSeconds' },
    );
  }
  // The codec calls `bind` with the context it was handed; each call below
  // registers that context's binding first and removes it once the codec is done.
  const bindings = new WeakMap<object, string>();
  const encryptionKey = deriveKey(key, 'jsails-mcp-state-encryption-v1');
  const codec = createRequestStateCodec<unknown>({
    key: deriveKey(key, 'jsails-mcp-state-mac-v1'),
    ttlSeconds,
    bind: (ctx) => {
      const value = bindings.get(ctx);
      if (value === undefined) {
        throw new Error('unbound');
      }
      return value;
    },
  });
  return Object.freeze({
    async seal(payload: SealedPayload, binding: StateBinding, ctx: ServerContext) {
      const bound = bindingValue(binding);
      bindings.set(ctx, bound);
      try {
        return await codec.mint({ c: encrypt(encryptionKey, JSON.stringify(payload), bound) }, ctx);
      } finally {
        bindings.delete(ctx);
      }
    },
    async open(state: string, binding: StateBinding, ctx: ServerContext): Promise<OpenedState> {
      const bound = bindingValue(binding);
      bindings.set(ctx, bound);
      let decoded: unknown;
      try {
        decoded = await codec.verify(state, ctx);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'malformed' };
      } finally {
        bindings.delete(ctx);
      }
      const sealed = isRecord(decoded) ? decoded.c : undefined;
      const payload = checkPayload(parsed(decrypt(encryptionKey, sealed, bound)));
      return payload === undefined ? { ok: false, reason: 'payload' } : { ok: true, payload };
    },
  });
}
