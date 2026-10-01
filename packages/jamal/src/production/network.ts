/**
 * The shared production Docker network.
 *
 * {@link ensureNetworkArgv} creates the {@link JAMAL_NETWORK} network when it
 * is missing and connects the named containers that already exist but are not
 * on it yet: a kamal-proxy booted before jamal used the network, or an
 * accessory a previous deploy started on the default bridge. Containers jamal
 * starts itself join with `--network`. The script is idempotent, so it runs on
 * every deploy. Every inspect is `--type container`: an accessory is named
 * after its service key (`mariadb`, `valkey`), and a plain inspect would also
 * match an image or volume of that name.
 */

import { remoteOpArgv } from './remote-op.js';

/**
 * The remote argv that ensures the network exists and that each container in
 * `connect` (when it exists) is attached to it.
 */
export function ensureNetworkArgv(connect: readonly string[]): readonly string[] {
  return remoteOpArgv({ kind: 'network.ensure', connect });
}
