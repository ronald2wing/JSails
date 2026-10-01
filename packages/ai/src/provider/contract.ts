/**
 * The provider contract: what an adapter (first-party or third-party)
 * implements, and the neutral request and response it exchanges with the
 * runtime.
 *
 * A provider declares its capabilities, including which schema lowering
 * profile its strict mode needs, and implements `stream` and `generate` over
 * the neutral {@link AiProviderRequest}. Tool and output schemas arrive
 * already lowered for that profile. A response carries the assistant message
 * (with the provider's raw content in `native`), a finish reason, normalized
 * usage, and the per-iteration usage that pricing needs when one response was
 * served by more than one model.
 */

import type { AiEffort, AiFinishReason, AiMessage } from '../content/types.js';
import type { JsonSchema } from '../structured-output/schema-restore.js';
import type { AiSchemaProfile } from '../structured-output/schema-lowering.js';
import type { AiUsageIteration } from '../usage/pricing.js';
import type { AiUsage } from '../usage/usage.js';

/** What a provider supports. */
export interface AiProviderCapabilities {
  readonly tools: boolean;
  readonly parallelTools: boolean;
  /** `native`: a response-format schema; `tool`: a tool-call fallback; `none`: unsupported. */
  readonly structuredOutput: 'native' | 'tool' | 'none';
  /** Whether tools may be sent in strict mode. */
  readonly strictTools: boolean;
  /** The lowering profile tool and output schemas are prepared with. */
  readonly schemaProfile: AiSchemaProfile;
  readonly images: boolean;
  readonly pdf: boolean;
  readonly reasoning: boolean;
  readonly promptCache: 'explicit' | 'automatic' | 'none';
  readonly countTokens: boolean;
}

/** A tool as a provider receives it: its schema already lowered. */
export interface AiToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly strict: boolean;
}

/** One block of top-level instructions (the system prompt). */
export interface AiInstruction {
  readonly text: string;
  readonly cache?: true;
}

/**
 * Provider-specific request options. Adapters add their own key by module
 * augmentation (`interface AiProviderOptions { anthropic?: ... }`).
 */
export interface AiProviderOptions {
  readonly [provider: string]: unknown;
}

/** The neutral request a provider receives. */
export interface AiProviderRequest {
  readonly model: string;
  readonly instructions: readonly AiInstruction[];
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiToolSpec[];
  readonly toolChoice: 'auto' | 'none';
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens: number;
  readonly effort?: AiEffort;
  readonly reasoning?: 'omitted' | 'summarized';
  readonly stopSequences?: readonly string[];
  /** A structured-output schema, already lowered for the provider's profile. */
  readonly output?: { readonly name: string; readonly schema: JsonSchema };
  readonly cache: 'auto' | 'off';
  readonly providerOptions?: AiProviderOptions;
}

/** A complete provider response. */
export interface AiProviderResponse {
  readonly id: string;
  /** The model that produced the final content (may differ from the request). */
  readonly model: string;
  readonly message: AiMessage;
  readonly finishReason: AiFinishReason;
  readonly usage: AiUsage;
  /** Usage per model and speed that served this response, for pricing. */
  readonly iterations: readonly AiUsageIteration[];
  readonly refusal?: { readonly category: string | null };
}

/** One streamed part of a provider response. */
export type AiProviderStreamPart =
  | { readonly type: 'response-start'; readonly id: string; readonly model: string }
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'reasoning-delta'; readonly delta: string }
  | { readonly type: 'tool-input-start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool-input-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'response-end'; readonly response: AiProviderResponse };

/** Per-call plumbing: cancellation and propagation headers (traceparent, baggage). */
export interface AiCallInit {
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

/** A model provider. */
export interface AiProvider {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  stream(request: AiProviderRequest, init: AiCallInit): AsyncIterable<AiProviderStreamPart>;
  generate(request: AiProviderRequest, init: AiCallInit): Promise<AiProviderResponse>;
  countTokens?(request: AiProviderRequest, init: AiCallInit): Promise<number>;
}

/** A provider bound to one model id. */
export interface AiModel {
  readonly provider: AiProvider;
  readonly id: string;
}
