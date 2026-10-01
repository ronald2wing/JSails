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

import { JAMAL_NETWORK } from './host-layout.js';

const ENSURE_SCRIPT = [
  `docker network inspect ${JAMAL_NETWORK} >/dev/null 2>&1 || docker network create ${JAMAL_NETWORK} >/dev/null || exit 1`,
  'for c in "$@"; do',
  '  docker inspect --type container "$c" >/dev/null 2>&1 || continue',
  `  [ "$(docker inspect --type container -f '{{if index .NetworkSettings.Networks "${JAMAL_NETWORK}"}}yes{{end}}' "$c")" = yes ] && continue`,
  `  docker network connect ${JAMAL_NETWORK} "$c" || exit 1`,
  'done',
].join('\n');

/**
 * The remote argv that ensures the network exists and that each container in
 * `connect` (when it exists) is attached to it.
 */
export function ensureNetworkArgv(connect: readonly string[]): readonly string[] {
  return ['sh', '-c', ENSURE_SCRIPT, 'sh', ...connect];
}
