/**
 * The serializable conversation (wire version 1) and its codec.
 *
 * A {@link Conversation} is plain JSON: an id, the owning actor's id, an
 * append-only message transcript, the summed usage, and a revision that grows
 * by one on every append. {@link appendToConversation} never rewrites earlier
 * messages (providers that bind reasoning to an unedited history reject an
 * edited prefix), and {@link parseConversation} is the only way persisted
 * data re-enters, validated field by field with value-free errors. Storage,
 * ownership enforcement, and optimistic concurrency belong to the app's data
 * layer.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type { AiActor, AiMessage } from '../content/types.js';
import { checkTranscript, readMessage } from '../content/validate-messages.js';
import { ZERO_USAGE, addUsage, isAiUsage, type AiUsage } from '../usage/usage.js';

/** A persisted conversation, wire version 1. */
export interface Conversation {
  readonly v: 1;
  readonly id: string;
  /** The owning actor's id, or `null` for an anonymous owner. */
  readonly ownerId: string | null;
  readonly messages: readonly AiMessage[];
  readonly usage: AiUsage;
  readonly revision: number;
}

/** What a run adds to a conversation: its new messages and the usage they cost. */
export interface ConversationAddition {
  readonly appended: readonly AiMessage[];
  readonly usage: AiUsage;
}

/** Options for {@link createConversation}. */
export interface CreateConversationInit {
  /** Defaults to a random UUID. */
  readonly id?: string;
  readonly owner: AiActor;
}

const MAX_ID_LENGTH = 256;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function invalidConversation(field: string): AiError {
  return new AiError('invalid_conversation', 'the conversation is invalid', {
    context: { field },
  });
}

function freezeUsage(usage: AiUsage): AiUsage {
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  });
}

function ownerIdOf(owner: AiActor): string | null {
  if (typeof owner !== 'object' || owner === null) {
    throw new AiError('invalid_options', 'a conversation owner is required');
  }
  if (owner.kind === 'anonymous') return null;
  if ((owner.kind !== 'user' && owner.kind !== 'service') || !isId(owner.id)) {
    throw new AiError('invalid_options', 'a user or service owner needs an id');
  }
  return owner.id;
}

/** A new, empty conversation at revision 0. */
export function createConversation(init: CreateConversationInit): Conversation {
  const id = init.id ?? globalThis.crypto.randomUUID();
  if (!isId(id)) throw new AiError('invalid_options', 'the conversation id is invalid');
  return Object.freeze({
    v: 1,
    id,
    ownerId: ownerIdOf(init.owner),
    messages: Object.freeze([]),
    usage: ZERO_USAGE,
    revision: 0,
  });
}

function isAddition(value: unknown): value is ConversationAddition {
  return isPlainObject(value) && Array.isArray(value.appended);
}

/**
 * Append messages (or a run's `appended` messages and usage) to a
 * conversation. Earlier messages are kept as they are; the combined
 * transcript must still be valid (`AiError('invalid_messages')` otherwise);
 * the revision grows by one. Appending nothing that costs nothing returns the
 * conversation unchanged.
 */
export function appendToConversation(
  conversation: Conversation,
  addition: readonly AiMessage[] | ConversationAddition,
): Conversation {
  const incoming = isAddition(addition) ? addition.appended : addition;
  const usage = isAddition(addition) ? addition.usage : ZERO_USAGE;
  if (!isAiUsage(usage)) throw new AiError('invalid_options', 'the appended usage is invalid');
  if (!Array.isArray(incoming)) {
    throw new AiError('invalid_options', 'the appended messages must be an array');
  }
  const offset = conversation.messages.length;
  const appended = (incoming as readonly unknown[]).map((message, index) =>
    readMessage(message, offset + index),
  );
  const costsNothing =
    usage.inputTokens === 0 && usage.outputTokens === 0 && usage.reasoningTokens === undefined;
  if (appended.length === 0 && costsNothing) return conversation;
  const messages = Object.freeze([...conversation.messages, ...appended]);
  checkTranscript(messages, 'transcript');
  return Object.freeze({
    v: 1,
    id: conversation.id,
    ownerId: conversation.ownerId,
    messages,
    usage: addUsage(conversation.usage, usage),
    revision: conversation.revision + 1,
  });
}

/**
 * Parse persisted data into a {@link Conversation}. Throws
 * `AiError('invalid_conversation')` naming only the failing field (or the
 * message index and rule) for anything that is not a valid version-1
 * conversation.
 */
export function parseConversation(value: unknown): Conversation {
  if (!isPlainObject(value)) throw invalidConversation('root');
  if (value.v !== 1) throw invalidConversation('v');
  if (!isId(value.id)) throw invalidConversation('id');
  if (value.ownerId !== null && !isId(value.ownerId)) throw invalidConversation('ownerId');
  if (!isAiUsage(value.usage)) throw invalidConversation('usage');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw invalidConversation('revision');
  }
  if (!Array.isArray(value.messages)) throw invalidConversation('messages');
  let messages: readonly AiMessage[];
  try {
    messages = (value.messages as readonly unknown[]).map((message, index) =>
      readMessage(message, index),
    );
    checkTranscript(messages, 'transcript');
  } catch (error) {
    if (error instanceof AiError && error.code === 'invalid_messages') {
      throw new AiError('invalid_conversation', 'the conversation is invalid', {
        context: { field: 'messages', ...error.context },
      });
    }
    throw error;
  }
  return Object.freeze({
    v: 1,
    id: value.id,
    ownerId: value.ownerId,
    messages: Object.freeze(messages),
    usage: freezeUsage(value.usage),
    revision: value.revision as number,
  });
}
