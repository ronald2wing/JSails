/**
 * The access seam between MCP definitions and the application's authorization.
 *
 * A definition carries an `access` value. {@link publicAccess}, the
 * framework's route access reference (`jsails/plugin-sdk`), is the only
 * built-in kind: it admits every actor and must say why. Any other access
 * value is an object the application chooses (a policy reference, a scope
 * list, a role) and is opaque to this package; the serving layer hands it to
 * the injected {@link McpAuthorize} gate together with the actor, once per
 * serving unit, and the gate answers with an {@link McpGateDecision}:
 *
 * - `'allow'` lists the item and lets the actor use it.
 * - `'hidden'` leaves the item out entirely. Calling it fails exactly like
 *   calling a name that does not exist, so a hidden item is not an existence
 *   oracle.
 * - `{ challenge: scopes }` lists the item but refuses to run it until the
 *   credential carries every named scope: over HTTP this is a `403
 *   insufficient_scope` step-up challenge. Use it when the principal could be
 *   granted the scopes (the scope names are public through the protected
 *   resource metadata anyway); use `'hidden'` when the principal itself is
 *   denied.
 *
 * Authorization is default-deny: anything but an exact decision above, or a
 * gate that throws, hides the item.
 */

import type { AccessRef, Awaitable } from 'jsails/plugin-sdk';
import { isPublicAccess, isRecord, publicAccess } from 'jsails/plugin-sdk';

export { isPublicAccess, publicAccess };

/**
 * Who is calling. A structural seam the transports fill in: an authenticated
 * user or service, an anonymous caller, or the local developer on stdio.
 */
export interface McpActor {
  readonly kind: 'user' | 'service' | 'anonymous' | 'developer';
  readonly id?: string;
  /** The scopes the presented credential carries; `'*'` for an unrestricted local actor. */
  readonly scopes: readonly string[] | '*';
}

/**
 * An access value: {@link publicAccess} (its reason is for reviewers, never
 * sent), or any application object the {@link McpAuthorize} gate understands.
 */
export type McpAccess = AccessRef | object;

/** What kind of definition a gate is deciding on. */
export type McpItemKind = 'tool' | 'resource' | 'resource-template' | 'prompt';

/** The item a gate decides on: its kind, its identifier, and its access value. */
export interface McpGateItem {
  readonly kind: McpItemKind;
  /** The tool or prompt name, the resource URI, or the resource template. */
  readonly name: string;
  readonly access: object;
}

/** A non-empty list of OAuth scope tokens. */
export type McpScopes = readonly [string, ...string[]];

/** A gate's answer for one item and one actor. */
export type McpGateDecision = 'allow' | 'hidden' | { readonly challenge: McpScopes };

/** The injected authorization gate, evaluated once per item per serving unit. */
export type McpAuthorize = (item: McpGateItem, actor: McpActor) => Awaitable<McpGateDecision>;

/** True when `access` is usable on a definition. */
export function isValidAccess(access: unknown): access is McpAccess {
  return (typeof access === 'object' && access !== null) || typeof access === 'function';
}

function isActorKind(kind: unknown): kind is McpActor['kind'] {
  return kind === 'user' || kind === 'service' || kind === 'anonymous' || kind === 'developer';
}

/**
 * A frozen copy of `value` when it is a well-formed {@link McpActor}: a known
 * kind, a non-empty `id` when present, and string scopes or `'*'`. Anything
 * else yields `undefined`; the caller raises its own option error.
 */
export function parseActor(value: unknown): McpActor | undefined {
  if (!isRecord(value) || !isActorKind(value.kind)) {
    return undefined;
  }
  if (value.id !== undefined && (typeof value.id !== 'string' || value.id.length === 0)) {
    return undefined;
  }
  let scopes: readonly string[] | '*';
  if (value.scopes === '*') {
    scopes = '*';
  } else if (Array.isArray(value.scopes)) {
    const listed: unknown[] = value.scopes;
    const copy: string[] = [];
    for (const scope of listed) {
      if (typeof scope !== 'string') {
        return undefined;
      }
      copy.push(scope);
    }
    scopes = Object.freeze(copy);
  } else {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind,
    ...(value.id === undefined ? {} : { id: value.id }),
    scopes,
  });
}

/** RFC 6749 `scope-token`: printable ASCII except space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** A gate decision after validation: `undefined` means the gate answered something malformed. */
export type CheckedDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'challenge'; readonly scopes: McpScopes };

/** Validate a gate's answer; anything malformed yields `undefined`. */
export function checkDecision(decision: unknown): CheckedDecision | undefined {
  if (decision === 'allow') {
    return { kind: 'allow' };
  }
  if (decision === 'hidden') {
    return { kind: 'hidden' };
  }
  if (!isRecord(decision) || !Array.isArray(decision.challenge)) {
    return undefined;
  }
  const scopes: unknown[] = decision.challenge;
  if (scopes.length === 0) {
    return undefined;
  }
  const checked: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !SCOPE_TOKEN.test(scope)) {
      return undefined;
    }
    if (!checked.includes(scope)) {
      checked.push(scope);
    }
  }
  const [first, ...rest] = checked;
  if (first === undefined) {
    return undefined;
  }
  const challenge: McpScopes = [first, ...rest];
  return { kind: 'challenge', scopes: Object.freeze(challenge) };
}
