/**
 * Signals plugin (`@jsails/signals`): provides a `RegistrySignalBus` over the
 * shared interceptor registry under the core-owned `signalsToken`.
 *
 * The bus class itself stays in `jsails/signals` because the runtime and core
 * tests construct it directly; this package only wires it up as a plugin.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { RegistrySignalBus, signalsToken } from 'jsails/signals';

/** Build the `signals` plugin. */
export function signalsPlugin(): JsailsPlugin {
  return definePlugin({
    name: 'signals',
    setup({ services, interceptorRegistry }) {
      services.provide(signalsToken, new RegistrySignalBus(interceptorRegistry));
    },
  });
}

// The declarative loader calls `mod.default(options)`, so the plugin barrel
// default-exports its factory alongside the named export.
export { signalsPlugin as default };
