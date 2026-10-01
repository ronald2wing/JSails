/**
 * The neutral content model: messages built from typed parts.
 *
 * A message has a role and a list of parts. Tool results live in the user
 * message that follows the assistant message that called the tools (the
 * Anthropic shape; an adapter for a `role: 'tool'` wire splits them). An
 * assistant message produced by a provider also keeps that provider's raw
 * content array in `native`, so the same provider receives its own blocks back
 * byte for byte (thinking signatures, citations, fallback and server-tool
 * blocks, and block types added later) while every other provider sees only
 * the neutral parts.
 */

import type { AiUsage } from '../usage/usage.js';

/** Who a message is from. `system` mid-conversation is the operator channel. */
export type AiRole = 'user' | 'assistant' | 'system';

/** Image media types every first-party provider accepts. */
export type AiImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Document media types a `file` part may carry. */
export type AiFileMediaType = 'application/pdf' | 'text/plain';

/** Where the bytes of an image or file come from. */
export type AiMediaSource =
  | { readonly kind: 'base64'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'url'; readonly url: string };

/** One item of a structured tool result. */
export type AiToolOutputItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: AiMediaSource };

/** What a tool returns to the model: plain text or text and image items. */
export type AiToolOutput = string | readonly AiToolOutputItem[];

/** Plain text. `cache` marks a prompt-cache breakpoint after this part. */
export interface AiTextPart {
  readonly type: 'text';
  readonly text: string;
  readonly cache?: true;
}

/** An image input. */
export interface AiImagePart {
  readonly type: 'image';
  readonly source: AiMediaSource;
  readonly cache?: true;
}

/** A document input (PDF or plain text). */
export interface AiFilePart {
  readonly type: 'file';
  readonly mediaType: AiFileMediaType;
  readonly source: AiMediaSource;
  readonly title?: string;
  readonly cache?: true;
}

/** Readable reasoning the model chose to show; empty when the provider omits it. */
export interface AiReasoningPart {
  readonly type: 'reasoning';
  readonly text: string;
}

/** A tool call the model made. `input` is the model's JSON input, not yet validated. */
export interface AiToolCallPart {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The result of one tool call, in the user message after the call. */
export interface AiToolResultPart {
  readonly type: 'tool-result';
  readonly id: string;
  readonly name: string;
  readonly output: AiToolOutput;
  readonly isError: boolean;
  readonly cache?: true;
}

/** Any part of a message. */
export type AiPart =
  AiTextPart | AiImagePart | AiFilePart | AiReasoningPart | AiToolCallPart | AiToolResultPart;

/** The parts a user message may carry. */
export type AiUserPart = AiTextPart | AiImagePart | AiFilePart | AiToolResultPart;

/** The parts an assistant message may carry. */
export type AiAssistantPart = AiTextPart | AiReasoningPart | AiToolCallPart;

/** Why a provider stopped generating. */
export type AiFinishReason =
  | 'stop'
  | 'stop-sequence'
  | 'length'
  | 'tool-calls'
  | 'refusal'
  | 'content-filter'
  | 'pause'
  | 'other';

/** How much effort the model spends (thinking depth and overall token spend). */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A provider's raw assistant content, kept for verbatim replay to the same
 * provider. `content` is the provider's own block array as JSON.
 */
export interface AiNativeContent {
  readonly provider: string;
  readonly model: string;
  readonly content: readonly unknown[];
}

/** Facts about how an assistant message was produced. */
export interface AiMessageMeta {
  readonly provider?: string;
  readonly model?: string;
  readonly responseId?: string;
  readonly finishReason?: AiFinishReason;
  readonly usage?: AiUsage;
}

/** One message of a conversation. */
export interface AiMessage {
  readonly role: AiRole;
  readonly parts: readonly AiPart[];
  /** Assistant messages only: the provider's raw content for verbatim replay. */
  readonly native?: AiNativeContent;
  readonly meta?: AiMessageMeta;
}

/** Every {@link AiRole}. */
export const AI_ROLES: readonly AiRole[] = Object.freeze(['user', 'assistant', 'system']);

/** Every {@link AiFinishReason}. */
export const AI_FINISH_REASONS: readonly AiFinishReason[] = Object.freeze([
  'stop',
  'stop-sequence',
  'length',
  'tool-calls',
  'refusal',
  'content-filter',
  'pause',
  'other',
]);

/** Every {@link AiEffort}, lowest first. */
export const AI_EFFORTS: readonly AiEffort[] = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Every {@link AiImageMediaType}. */
export const AI_IMAGE_MEDIA_TYPES: readonly AiImageMediaType[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Every {@link AiFileMediaType}. */
export const AI_FILE_MEDIA_TYPES: readonly AiFileMediaType[] = Object.freeze([
  'application/pdf',
  'text/plain',
]);

/**
 * Who a run acts for. Structural for now; it becomes the framework's `Actor`
 * once that contract exists, without changing this shape.
 */
export interface AiActor {
  readonly kind: 'user' | 'service' | 'anonymous';
  readonly id?: string;
}

/**
 * The smallest app context a run and its tools receive. Apps extend it. A run
 * takes it as a plain object: each tool call gets a copy of its own
 * properties plus the call fields, which would silently lose a class
 * instance's getters, methods, and private fields.
 */
export interface AiBaseContext {
  readonly actor: AiActor;
}
