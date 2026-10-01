/**
 * First-party `theme` plugin: provides the resolved theme tokens under
 * {@link themeToken}.
 *
 * `themePlugin(options?)` configures a plugin named `theme` on the
 * `definePlugin` contract. Its options are data, checked by a strict schema
 * when the factory is called (a failure is `config.invalid_options`, before
 * anything runs):
 *
 * - `tokens` is the application layer (highest precedence);
 * - `contributions` are plugin layers, folded in order; same-named
 *   contributions spread-merge (later wins per key);
 * - `active` selects which named theme's effective tokens fold into the active
 *   map (step 3 of the ordered fold). An unknown name contributes no tokens.
 *
 * Every token name, token value and theme name must be injectable into CSS, so
 * an unsafe one is refused with the options rather than at render time.
 * Setup resolves the frozen {@link ThemeResolution} and provides it; it opens
 * nothing and returns no cleanup. A second provider is rejected by the runner
 * before any setup runs.
 */

import {
  createServiceToken,
  definePlugin,
  type PluginFactory,
  type ServiceToken,
} from 'jsails/kernel';
import { z } from 'zod';

import { isSafeCssTokenName, isSafeCssValue, isSafeThemeName } from './css-safety.js';
import {
  resolveThemeTokens,
  type ThemeContribution,
  type ThemeResolution,
  type ThemeTokenMap,
} from './tokens.js';

/**
 * Opaque token for the resolved theme surface. Defined once here and shared
 * by the provider ({@link themePlugin}) and any consumer (the admin panel, a
 * custom renderer, or the starter's layout), which serializes it with
 * {@link themeTokensToCss}.
 */
export const themeToken: ServiceToken<ThemeResolution> =
  createServiceToken<ThemeResolution>('theme');

const tokenMap = z.record(
  z.string().refine(isSafeCssTokenName, { message: 'must be a CSS custom-property name' }),
  z.string().refine(isSafeCssValue, { message: 'must be a CSS value that can be injected' }),
);

const themeName = z.string().refine(isSafeThemeName, {
  message: 'must use only letters, digits, dots, underscores and hyphens',
});

/**
 * Options accepted by {@link themePlugin}.
 *
 * @public
 */
export interface ThemePluginOptions {
  /** Application-level token overrides (highest precedence). */
  readonly tokens?: ThemeTokenMap;
  /** Plugin-layer contributions, folded in order; same-named ones spread-merge. */
  readonly contributions?: readonly ThemeContribution[];
  /** The named theme whose effective tokens fold into the active map. */
  readonly active?: string;
}

const themeOptions: z.ZodType<ThemePluginOptions> = z
  .object({
    tokens: tokenMap.optional(),
    contributions: z
      .array(
        z
          .object({
            source: z.string().min(1).max(200),
            tokens: tokenMap,
            name: themeName.optional(),
          })
          .strict(),
      )
      .optional(),
    active: themeName.optional(),
  })
  .strict();

/**
 * The first-party `theme` plugin. Nothing is resolved until its setup runs,
 * which provides the merged token surface under {@link themeToken}.
 */
export const themePlugin: PluginFactory<ThemePluginOptions | undefined> = definePlugin({
  name: 'theme',
  options: themeOptions.optional(),
  provides: [themeToken],
  setup({ options, services }) {
    services.provide(
      themeToken,
      resolveThemeTokens(options?.tokens ?? {}, options?.contributions ?? [], {
        active: options?.active,
      }),
    );
  },
});
