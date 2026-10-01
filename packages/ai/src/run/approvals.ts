/**
 * Approval binding: the digest a pending call carries and the check that an
 * incoming decision matches it.
 *
 * Approvals usually arrive from a browser, so they are untrusted. A decision
 * is honoured only when it names a call that is pending in the trusted
 * history, with the same tool name and the same {@link toolCallDigest}. The
 * digest covers the actor, the call id, the tool name, and the canonical
 * JSON of the input, so an approval made for one actor, or on one input, can
 * never release a different call. The digest is synchronous, so `run`
 * binds every decision while it validates its options and a forged one is
 * refused before anything is sent.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { toolCallsOf } from '../content/validate-messages.js';
import type { AiActor, AiMessage, AiToolCallPart } from '../content/types.js';
import type { AiApproval } from './run-contract.js';
import { sha256Hex } from './sha256.js';

/** The most decisions one run accepts. */
const MAX_APPROVALS = 256;

/** A lowercase hex SHA-256 digest. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The value-free error for an approval that is malformed or matches no pending call. */
export function invalidApproval(reason: string): AiError {
  return new AiError('invalid_input', 'the approvals are invalid', { context: { reason } });
}

/**
 * JSON with object keys sorted at every level, so equal values always give
 * equal text. The input is plain JSON (tool-call inputs are copied through
 * `copyJson` when a message is read).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The digest binding a decision to one call made for one actor. */
export function toolCallDigest(
  actor: AiActor,
  call: Pick<AiToolCallPart, 'id' | 'name' | 'input'>,
): string {
  const text = canonicalJson([
    'jsails.ai.approval.v1',
    actor.kind,
    actor.id ?? null,
    call.id,
    call.name,
    call.input,
  ]);
  return sha256Hex(new TextEncoder().encode(text));
}

/** Check the shape of incoming decisions; ids must be unique. Returns them keyed by id. */
export function readApprovals(value: unknown): ReadonlyMap<string, AiApproval> {
  const approvals = new Map<string, AiApproval>();
  if (value === undefined) return approvals;
  if (!Array.isArray(value) || value.length > MAX_APPROVALS) throw invalidApproval('shape');
  for (const entry of value as readonly unknown[]) {
    if (
      !isPlainObject(entry) ||
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      entry.id.length > 256 ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      entry.name.length > 256 ||
      typeof entry.inputDigest !== 'string' ||
      !DIGEST_PATTERN.test(entry.inputDigest) ||
      (entry.decision !== 'approve' && entry.decision !== 'deny')
    ) {
      throw invalidApproval('shape');
    }
    if (approvals.has(entry.id)) throw invalidApproval('duplicate');
    approvals.set(
      entry.id,
      Object.freeze({
        id: entry.id,
        name: entry.name,
        inputDigest: entry.inputDigest,
        decision: entry.decision,
      }),
    );
  }
  return approvals;
}

/**
 * Bind every decision to a call still pending in the trusted history: the
 * tool calls of `resume`, the assistant message the history ends with. A
 * decision must name one of them, with its tool name and its digest for
 * `actor`; anything else is `AiError('invalid_input')`.
 */
export function bindApprovals(
  approvals: ReadonlyMap<string, AiApproval>,
  resume: AiMessage | undefined,
  actor: AiActor | undefined,
): void {
  if (approvals.size === 0) return;
  if (resume === undefined) throw invalidApproval('no_pending_calls');
  const calls = toolCallsOf(resume);
  for (const approval of approvals.values()) {
    const call = calls.find((candidate) => candidate.id === approval.id);
    if (
      call === undefined ||
      call.name !== approval.name ||
      actor === undefined ||
      toolCallDigest(actor, call) !== approval.inputDigest
    ) {
      throw invalidApproval('mismatch');
    }
  }
}
