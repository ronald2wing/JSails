/**
 * Frozen message constructors and readers: {@link userMessage},
 * {@link systemMessage}, and {@link textOf}.
 *
 * Constructors are for server code building trusted history; untrusted
 * browser input goes through `parseUserInput` instead.
 */

import { readMessage } from './validate-messages.js';
import type { AiMessage, AiPart, AiUserPart } from './types.js';

/**
 * A frozen user message from text or parts. Throws
 * `AiError('invalid_messages')` for a part a user message cannot carry.
 */
export function userMessage(content: string | readonly AiUserPart[]): AiMessage {
  const parts: readonly AiPart[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return readMessage({ role: 'user', parts }, 0);
}

/**
 * A frozen mid-conversation operator message. It must follow a user message
 * and be last or followed by an assistant message (checked when the list is
 * validated).
 */
export function systemMessage(text: string): AiMessage {
  return readMessage({ role: 'system', parts: [{ type: 'text', text }] }, 0);
}

/** The message's text parts, concatenated in order. */
export function textOf(message: AiMessage): string {
  let text = '';
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}
