/**
 * Cost in integer micro-USD from an app-supplied pricing function.
 *
 * The package ships no price table: prices change, some are tiered by prompt
 * size, some depend on the speed a request ran at, and a server-side fallback
 * bills each iteration at the rate of the model that ran it. Cost is therefore
 * computed per usage iteration (one provider, model, and speed each) through
 * an {@link AiPricing} function. {@link createPricingTable} builds one from a
 * plain table with tiers and speed overrides.
 */

import { AiError } from '../errors/ai-error.js';
import { isAiUsage, type AiUsage } from './usage.js';

/** What a price depends on besides the token counts. */
export interface AiPricingContext {
  readonly provider: string;
  readonly model: string;
  /** The speed the request ran at (for example `'fast'`); absent means standard. */
  readonly speed?: string;
}

/** One billed slice of a response: the usage of one model at one speed. */
export interface AiUsageIteration extends AiPricingContext {
  readonly usage: AiUsage;
}

/** Prices a usage in integer micro-USD. Must return a non-negative safe integer. */
export type AiPricing = (usage: AiUsage, context: AiPricingContext) => number;

/** Token prices in USD per million tokens. */
export interface AiTokenPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Defaults to `inputPerMTok` (an overestimate, so budgets stay conservative). */
  readonly cacheReadPerMTok?: number;
  /** Defaults to `inputPerMTok`. */
  readonly cacheWritePerMTok?: number;
}

/** A price tier that applies when the request's input exceeds a token count. */
export interface AiPriceTier extends AiTokenPrice {
  readonly aboveInputTokens: number;
}

/** The price of one model: a base price, optional prompt-size tiers, optional speeds. */
export interface AiModelPrice extends AiTokenPrice {
  /** Ascending by `aboveInputTokens`; the last tier the input exceeds applies. */
  readonly tiers?: readonly AiPriceTier[];
  /** Full price overrides per non-standard speed, such as `fast`. */
  readonly speeds?: Readonly<Record<string, AiTokenPrice>>;
}

/** The largest price accepted, in USD per million tokens. */
const MAX_PRICE_PER_MTOK = 1_000_000;

function invalidPricing(reason: string): AiError {
  return new AiError('invalid_options', 'the pricing table is invalid', { context: { reason } });
}

function checkPrice(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidPricing(reason);
  }
  if (value > MAX_PRICE_PER_MTOK) throw invalidPricing(reason);
  return value;
}

interface PicoPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * Convert a USD-per-MTok price to pico-USD per token. A USD-per-MTok price is
 * numerically micro-USD per token, so scaling by 1e6 gives an integer for any
 * price with at most six decimals and keeps the arithmetic exact.
 */
function toPico(price: AiTokenPrice, reason: string): PicoPrice {
  const input = Math.round(checkPrice(price.inputPerMTok, reason) * 1e6);
  return Object.freeze({
    input,
    output: Math.round(checkPrice(price.outputPerMTok, reason) * 1e6),
    cacheRead:
      price.cacheReadPerMTok === undefined
        ? input
        : Math.round(checkPrice(price.cacheReadPerMTok, reason) * 1e6),
    cacheWrite:
      price.cacheWritePerMTok === undefined
        ? input
        : Math.round(checkPrice(price.cacheWritePerMTok, reason) * 1e6),
  });
}

interface CompiledModelPrice {
  readonly base: PicoPrice;
  readonly tiers: readonly { readonly above: number; readonly price: PicoPrice }[];
  readonly speeds: ReadonlyMap<string, PicoPrice>;
}

function compileModel(price: AiModelPrice): CompiledModelPrice {
  if (typeof price !== 'object' || price === null) throw invalidPricing('model_price');
  const tiers: { above: number; price: PicoPrice }[] = [];
  let previous = -1;
  for (const tier of price.tiers ?? []) {
    const above = tier.aboveInputTokens;
    if (!Number.isSafeInteger(above) || above < 0 || above <= previous) {
      throw invalidPricing('tier_order');
    }
    previous = above;
    tiers.push({ above, price: toPico(tier, 'tier_price') });
  }
  const speeds = new Map<string, PicoPrice>();
  for (const [speed, speedPrice] of Object.entries(price.speeds ?? {})) {
    speeds.set(speed, toPico(speedPrice, 'speed_price'));
  }
  return { base: toPico(price, 'model_price'), tiers, speeds };
}

function picoCost(usage: AiUsage, price: PicoPrice): number {
  const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const total =
    uncached * price.input +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.outputTokens * price.output;
  if (!Number.isSafeInteger(total)) {
    throw new AiError('invalid_options', 'the cost exceeds the representable range');
  }
  return total;
}

/**
 * Build an {@link AiPricing} from a table keyed by model id, or by
 * `provider/model` to price the same model id differently per provider (the
 * provider-qualified key wins). A model missing from the table, or a speed the
 * model has no override for, throws `AiError('invalid_options')` instead of
 * silently costing nothing, so a budget can never be bypassed by an unpriced
 * model.
 */
export function createPricingTable(table: Readonly<Record<string, AiModelPrice>>): AiPricing {
  if (typeof table !== 'object' || table === null) throw invalidPricing('table');
  const compiled = new Map<string, CompiledModelPrice>();
  for (const [key, price] of Object.entries(table)) compiled.set(key, compileModel(price));
  return (usage, context) => {
    const model =
      compiled.get(`${context.provider}/${context.model}`) ?? compiled.get(context.model);
    if (model === undefined) {
      throw new AiError('invalid_options', 'no price is configured for the model', {
        context: { reason: 'unpriced_model' },
      });
    }
    let price = model.base;
    if (context.speed !== undefined && context.speed !== 'standard') {
      const speedPrice = model.speeds.get(context.speed);
      if (speedPrice === undefined) {
        throw new AiError('invalid_options', 'no price is configured for the speed', {
          context: { reason: 'unpriced_speed' },
        });
      }
      price = speedPrice;
    } else {
      for (const tier of model.tiers) {
        if (usage.inputTokens > tier.above) price = tier.price;
      }
    }
    return Math.round(picoCost(usage, price) / 1e6);
  };
}

/**
 * The total cost of `iterations` in integer micro-USD. Each iteration is
 * priced on its own (tiers apply per request, and a fallback iteration is
 * billed at its own model's rate). Throws `AiError('invalid_options')` when an
 * iteration's usage is malformed or the pricing function returns anything but
 * a non-negative safe integer.
 */
export function costMicroUsd(iterations: readonly AiUsageIteration[], pricing: AiPricing): number {
  let total = 0;
  for (const iteration of iterations) {
    if (!isAiUsage(iteration.usage)) {
      throw new AiError('invalid_options', 'a usage iteration is malformed');
    }
    const cost = pricing(iteration.usage, {
      provider: iteration.provider,
      model: iteration.model,
      ...(iteration.speed === undefined ? {} : { speed: iteration.speed }),
    });
    if (!Number.isSafeInteger(cost) || cost < 0) {
      throw new AiError('invalid_options', 'the pricing function returned an invalid cost');
    }
    total += cost;
    if (!Number.isSafeInteger(total)) {
      throw new AiError('invalid_options', 'the cost exceeds the representable range');
    }
  }
  return total;
}
