/**
 * First-party `signals` plugin (`@jsails/signals`).
 *
 * Provides the registry-backed signal bus under the core-owned
 * `signalsToken`.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { signalsToken, SignalError } from 'jsails/signals';
import { RegistrySignalBus } from './registry.js';

export function signalsPlugin(): JsailsPlugin {
  return definePlugin({
    name: 'signals',
    setup({ services, interceptorRegistry }) {
      if (!interceptorRegistry) {
        throw new SignalError(
          'shared interceptor registry is unavailable — ensure the signals plugin is ' +
            'run inside a framework that exposes the shared registry on the setup context',
        );
      }
      services.provide(signalsToken, new RegistrySignalBus(interceptorRegistry));
    },
  });
}
