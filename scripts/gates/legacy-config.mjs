/**
 * The app config's legacy keys go through one compat mapper, and shrink.
 *
 * `core/src/app/config/legacy.ts` is the only module that accepts a legacy
 * app config key: a key the kernel's `AppConfig` no longer has, kept until
 * the package providing its replacement removes it. Its
 * `LEGACY_CONFIG_SURFACES` table lists every such surface (a top-level key, a
 * `plugins.` key, the specifier forms of `plugins.use`, and the legacy
 * `jsails.app.js` root). This gate holds that table equal to
 * `scripts/expected-failures/legacy-config.json`, which names the package
 * that removes each surface (`fixedBy`) and only shrinks. A surface added to
 * the table without a ledger entry fails, so a key cannot become legacy
 * without review. A ledger entry whose surface is no longer in the table
 * fails too, so the removing package deletes both together. The gate reads
 * the source table, so it needs no build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGateLedger, ratchet } from '../expected-failures.mjs';

export const name = 'legacy-config';
export const description =
  'the app config legacy keys are the compat mapper table, each ledgered with its removing package; the list only shrinks';
export const needsBuild = false;

/** The compat mapper, relative to the repository root. */
export const MAPPER = 'core/src/app/config/legacy.ts';

/**
 * The surfaces the mapper's `LEGACY_CONFIG_SURFACES` table lists, in table
 * order. A `key` is a string literal or a module-level string constant.
 */
export function legacySurfaces(source) {
  const constants = new Map(
    [...source.matchAll(/^(?:export\s+)?const\s+([A-Z_]+)\s*=\s*'([^']+)';/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const start = source.indexOf('LEGACY_CONFIG_SURFACES');
  if (start === -1) return undefined;
  const open = source.indexOf('[', source.indexOf('Object.freeze(', start));
  const close = source.indexOf(']);', open);
  if (open === -1 || close === -1) return undefined;
  const table = source.slice(open, close);
  return [...table.matchAll(/\{\s*key:\s*(?:'([^']+)'|([A-Z_]+))\s*,/g)].map(
    (match) => match[1] ?? constants.get(match[2]) ?? `<unresolved ${match[2]}>`,
  );
}

export function run({ repoRoot }) {
  const path = join(repoRoot, MAPPER);
  if (!existsSync(path)) return [`${MAPPER} is missing; the compat mapper owns the legacy keys`];
  const surfaces = legacySurfaces(readFileSync(path, 'utf8'));
  if (surfaces === undefined || surfaces.length === 0) {
    return [`${MAPPER} has no LEGACY_CONFIG_SURFACES table`];
  }
  const failures = [];
  const seen = new Set();
  for (const surface of surfaces) {
    if (surface.startsWith('<unresolved')) failures.push(`${MAPPER}: ${surface} is not a string`);
    if (seen.has(surface)) failures.push(`${MAPPER} lists ${surface} twice`);
    seen.add(surface);
  }
  const ledger = readGateLedger(name, {
    dir: join(repoRoot, 'scripts', 'expected-failures'),
    root: repoRoot,
  });
  const { unlisted, fixed } = ratchet(ledger, surfaces);
  failures.push(
    ...unlisted.map(
      (surface) =>
        `${surface} is a new legacy config surface; give it a replacement now, or ledger it in legacy-config.json with the package that removes it`,
    ),
    ...fixed.map(
      (surface) =>
        `fixed: ${surface} is no longer a legacy config surface; remove it from legacy-config.json`,
    ),
  );
  return failures;
}
