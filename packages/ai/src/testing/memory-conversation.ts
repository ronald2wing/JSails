/**
 * {@link createMemoryConversation}: a conversation held in memory for tests,
 * persisted the way an app would persist it.
 *
 * Every append goes through `appendToConversation` and then a JSON round trip
 * and `parseConversation`, exactly what a real store does on write and read,
 * so a test fails here if a run produced anything that would not survive
 * persistence. It is a test helper: one process, no owner checks, no
 * concurrency control. A production store belongs to the app's data layer.
 */

import type { AiMessage } from '../content/types.js';
import {
  appendToConversation,
  createConversation,
  parseConversation,
  type Conversation,
  type ConversationAddition,
  type CreateConversationInit,
} from '../conversation/conversation.js';

/** A conversation in memory. */
export interface MemoryConversation {
  /** The current conversation, as a store would return it. */
  readonly conversation: Conversation;
  /** Its messages: pass them as a run's `history`. */
  readonly messages: readonly AiMessage[];
  /** Append messages, or a run's result (its `appended` and `usage`), and persist. */
  append(addition: readonly AiMessage[] | ConversationAddition): Conversation;
}

function persist(conversation: Conversation): Conversation {
  return parseConversation(JSON.parse(JSON.stringify(conversation)) as unknown);
}

/** A new, empty conversation in memory. */
export function createMemoryConversation(init: CreateConversationInit): MemoryConversation {
  let current = persist(createConversation(init));
  return Object.freeze({
    get conversation(): Conversation {
      return current;
    },
    get messages(): readonly AiMessage[] {
      return current.messages;
    },
    append(addition: readonly AiMessage[] | ConversationAddition): Conversation {
      current = persist(appendToConversation(current, addition));
      return current;
    },
  });
}
