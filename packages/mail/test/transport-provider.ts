/**
 * A plugin that provides a given mail transport under `mailTransportToken`,
 * as a transport-owning plugin would, so a test can name the token in
 * `mailPlugin({ transport })` and keep the instance to inspect.
 */

import { definePlugin, type PluginInstance } from 'jsails/kernel';

import { mailTransportToken, type MailTransport } from '../src/index.js';

/** An instance of a plugin that provides `transport` and never closes it. */
export function transportProvider(transport: MailTransport): PluginInstance {
  return definePlugin({
    name: 'test-mail-transport',
    provides: [mailTransportToken],
    setup({ services }) {
      services.provide(mailTransportToken, transport);
    },
  })();
}
