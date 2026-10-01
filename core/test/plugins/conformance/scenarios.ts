/**
 * The marketplace conformance scenarios: owner decision 1 as executable
 * claims, one test per row of the trust and lifecycle table, written against
 * {@link MarketplaceDriver} so every implementation answers the same questions.
 *
 * Locked mode (the default for every preset): no database write and no admin
 * action can make code run; the set is exactly the committed lock. Managed
 * mode (opt-in): a database row activates code only when the app sealed it,
 * the bytes hash to its digest, an allowed and unrevoked publisher signed them
 * inside its id namespace, and the permissions fit the ceilings. A row that
 * fails is skipped and reported, and the site still boots, unless the id is
 * `required`. Code-declared plugins always win, and an install applies
 * without a redeploy.
 *
 * Each test asserts the target behaviour. Tests today's implementation fails
 * are listed, with the reason and the closing package, in
 * `scripts/expected-failures/marketplace.json`.
 */

import assert from 'node:assert/strict';

import {
  buildBundle,
  buildCatalog,
  PUBLISHERS,
  RECORDER_KEY,
  sha256,
  tarGz,
  type BuiltBundle,
  type BundleRecorder,
  type BundleSpec,
} from './bundles.js';
import {
  LOCKED_MODE_CODE,
  type Actor,
  type BundleRef,
  type MarketplaceDriver,
  type MarketplaceDriverFactory,
} from './driver.js';

const PLUGIN_ACTIONS = Object.freeze([
  'plugins.view',
  'plugins.settings',
  'plugins.install',
  'plugins.update',
  'plugins.toggle',
  'plugins.rollback',
  'plugins.remove',
]);

/** The site owner, freshly authenticated, holding every plugin action. */
const OWNER: Actor = Object.freeze({
  id: 'owner',
  grants: PLUGIN_ACTIONS,
  authenticatedMinutesAgo: 1,
});

/** Run `scenario` against a fresh deployment and always release it. */
async function withDeployment(
  factory: MarketplaceDriverFactory,
  scenario: (driver: MarketplaceDriver) => Promise<void>,
): Promise<void> {
  const driver = await factory();
  try {
    await scenario(driver);
  } finally {
    await driver.close();
  }
}

/** Store a bundle and install it as the owner; the install itself must succeed. */
async function install(
  driver: MarketplaceDriver,
  spec: BundleSpec,
): Promise<{ readonly bundle: BuiltBundle; readonly ref: BundleRef }> {
  const bundle = buildBundle(spec);
  const ref = await driver.putBundle(bundle);
  const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
  assert.deepEqual(outcome, { ok: true }, `installing ${bundle.label} as the owner succeeds`);
  return { bundle, ref };
}

/** Write the activation row an attacker would write. */
async function forge(
  driver: MarketplaceDriver,
  bundle: BuiltBundle,
  enabled: boolean,
  options: { readonly withSealKey?: boolean } = {},
): Promise<void> {
  const { table, row } = driver.forgeRow(
    { id: bundle.id, version: bundle.version, enabled },
    options,
  );
  await driver.sqlWrite(table, row);
}

function assertNotRun(loaded: readonly string[], label: string, claim: string): void {
  assert.ok(!loaded.includes(label), `${claim}: ${label} must not run`);
}

function assertBooted(report: { booted: boolean; failure?: string }, claim: string): void {
  assert.equal(report.booted, true, `${claim}: the site must still boot (${report.failure ?? ''})`);
}

function assertReported(issues: readonly string[], code: string, claim: string): void {
  assert.ok(issues.includes(code), `${claim}: the boot must report ${code}`);
}

/** One claim: a title and the steps that check it against a fresh deployment. */
export interface Scenario {
  readonly title: string;
  readonly run: (driver: MarketplaceDriver) => Promise<void>;
}

/** The claims of one row group of the trust table. */
export interface ScenarioGroup {
  readonly name: string;
  readonly scenarios: readonly Scenario[];
}

const groups: ScenarioGroup[] = [];

function group(
  name: string,
  define: (scenario: (title: string, run: Scenario['run']) => void) => void,
): void {
  const scenarios: Scenario[] = [];
  define((title, run) => scenarios.push({ title, run }));
  groups.push({ name, scenarios: Object.freeze(scenarios) });
}

group('locked mode', (scenario) => {
  scenario(
    'boots without calling an activation store that throws on every call',
    async (driver) => {
      const report = await driver.boot('locked', { throwingStore: true });
      assertBooted(report, 'locked boot with a throwing store');
      assert.equal(report.storeCalls, 0, 'a locked boot never calls the activation store');
    },
  );

  scenario('never loads a plugin from a row written through SQL', async (driver) => {
    const bundle = buildBundle({ id: 'acme-notes' });
    await driver.putBundle(bundle);
    await forge(driver, bundle, true, { withSealKey: true });
    const report = await driver.boot('locked');
    assertNotRun(report.loaded, bundle.label, 'locked mode with a forged row');
    assert.ok(!report.imported.includes(bundle.label), 'its module is never evaluated');
    assert.equal(report.storeCalls, 0, 'a locked boot never reads activation state');
  });

  scenario('refuses every code-changing admin action', async (driver) => {
    // The plugin has real state (two installed versions and an enabled row,
    // left by a managed deployment that now ships locked), so each action
    // below would succeed in managed mode and only the mode can refuse it.
    const { bundle: first } = await install(driver, { id: 'acme-notes', version: '1.0.0' });
    await install(driver, { id: 'acme-notes', version: '2.0.0' });
    const before = (await driver.status()).rows;
    await driver.boot('locked');
    const other = await driver.putBundle(buildBundle({ id: 'acme-other' }));
    const refused = { ok: false, code: LOCKED_MODE_CODE };
    assert.deepEqual(
      await driver.adminAction(OWNER, { kind: 'install', bundle: other }),
      refused,
      'locked mode must refuse install',
    );
    for (const action of [
      { kind: 'disable', id: first.id },
      { kind: 'enable', id: first.id },
      { kind: 'rollback', id: first.id, version: first.version },
      { kind: 'remove', id: first.id },
    ] as const) {
      assert.deepEqual(
        await driver.adminAction(OWNER, action),
        refused,
        `locked mode must refuse ${action.kind} with ${LOCKED_MODE_CODE}`,
      );
    }
    assert.deepEqual((await driver.status()).rows, before, 'no refused action changed a row');
  });

  scenario('no admin action or table write switches the deployment to managed', async (driver) => {
    await driver.boot('locked');
    const bundle = buildBundle({ id: 'acme-notes' });
    const ref = await driver.putBundle(bundle);
    await driver.adminAction(OWNER, { kind: 'setMode', mode: 'managed' });
    await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    await driver.adminAction(OWNER, { kind: 'enable', id: bundle.id });
    await driver.adminAction(OWNER, { kind: 'settings', id: bundle.id, values: {} });
    await forge(driver, bundle, true, { withSealKey: true });
    const report = await driver.boot('locked');
    assertBooted(report, 'locked boot after every attempt');
    assertNotRun(report.loaded, bundle.label, 'locked mode after admin actions and SQL writes');
    assert.equal(report.storeCalls, 0, 'the deployment is still locked');
  });

  scenario('no environment variable selects managed mode', async (driver) => {
    const bundle = buildBundle({ id: 'acme-notes' });
    await driver.putBundle(bundle);
    await forge(driver, bundle, true, { withSealKey: true });
    const report = await driver.boot('locked', {
      env: {
        JSAILS_PLUGINS_MANAGED: 'true',
        JSAILS_PLUGINS_MODE: 'managed',
        JSAILS_MARKETPLACE_ACTIVATION: 'managed',
      },
    });
    assertNotRun(report.loaded, bundle.label, 'locked mode with managed-looking variables');
    assert.equal(report.storeCalls, 0, 'the environment never selects managed mode');
  });

  scenario('loads exactly the plugins pinned in the lock', async (driver) => {
    const bundle = buildBundle({ id: 'acme-pinned' });
    const ref = await driver.putBundle(bundle);
    const report = await driver.boot('locked', { lock: [ref] });
    assertBooted(report, 'locked boot with a lock entry');
    assert.ok(report.loaded.includes(bundle.label), 'a plugin pinned in the lock runs');
    assert.equal(report.storeCalls, 0, 'the lock needs no activation state');
  });

  scenario(
    "fails the boot when a pinned plugin's bytes differ from the lock digest",
    async (driver) => {
      const pinned = buildBundle({ id: 'acme-pinned' });
      const ref = await driver.putBundle(pinned);
      const evil = buildBundle({ id: 'acme-pinned', variant: 'evil' });
      await driver.putBundle(evil, { replacing: ref });
      const report = await driver.boot('locked', { lock: [ref] });
      assert.ok(!report.imported.includes(evil.label), 'the replaced bytes are never evaluated');
      assert.equal(report.booted, false, 'a lock digest mismatch must fail a locked boot');
    },
  );

  scenario('the static export resolves an empty plugin set in either mode', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    for (const mode of ['locked', 'managed'] as const) {
      const report = await driver.boot(mode, { shape: 'static' });
      assertBooted(report, `static ${mode} boot`);
      assertNotRun(report.loaded, bundle.label, `the static export in ${mode} mode`);
      assert.equal(report.storeCalls, 0, 'the static export never reads activation state');
    }
  });
});

group('managed mode: a database-only attacker', (scenario) => {
  scenario('a row inserted through SQL for a stored bundle never loads', async (driver) => {
    const bundle = buildBundle({ id: 'acme-notes' });
    await driver.putBundle(bundle);
    await forge(driver, bundle, true);
    const report = await driver.boot('managed');
    assertNotRun(report.loaded, bundle.label, 'a row the app did not seal');
    assertBooted(report, 'a boot with an unsealed row');
    assertReported(report.issues, 'unsealed_state', 'an unsealed row');
  });

  scenario('flipping a disabled row to enabled through SQL does not load it', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    await driver.adminAction(OWNER, { kind: 'disable', id: bundle.id });
    await forge(driver, bundle, true);
    const report = await driver.boot('managed');
    assertNotRun(report.loaded, bundle.label, 'a disabled row flipped through SQL');
    assertBooted(report, 'a boot with a flipped row');
  });

  scenario(
    'switching the active version through SQL does not load the other version',
    async (driver) => {
      const { bundle: old } = await install(driver, { id: 'acme-notes', version: '1.0.0' });
      await install(driver, { id: 'acme-notes', version: '2.0.0' });
      await forge(driver, old, true);
      const report = await driver.boot('managed');
      assertNotRun(report.loaded, old.label, 'an older version selected through SQL');
      assertBooted(report, 'a boot with a switched version');
    },
  );

  scenario('replaying an earlier valid row after a disable does not load it', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const captured = (await driver.status()).rows.map((row) => ({ ...row }));
    await driver.adminAction(OWNER, { kind: 'disable', id: bundle.id });
    const { table } = driver.forgeRow({ id: bundle.id, version: bundle.version, enabled: true });
    for (const row of captured) await driver.sqlWrite(table, row);
    const report = await driver.boot('managed');
    assertNotRun(report.loaded, bundle.label, 'a replayed row');
    assertBooted(report, 'a boot with a replayed row');
  });

  scenario('knowing the seal key does not make an unsigned bundle load', async (driver) => {
    const bundle = buildBundle({ id: 'acme-notes', signedBy: null });
    await driver.putBundle(bundle);
    await forge(driver, bundle, true, { withSealKey: true });
    const report = await driver.boot('managed');
    assertNotRun(report.loaded, bundle.label, 'an unsigned bundle behind a sealed row');
    assertBooted(report, 'a boot with a sealed row for an unsigned bundle');
    assertReported(report.issues, 'untrusted_publisher', 'an unsigned bundle');
  });

  scenario(
    'bytes replaced in the bundle store are refused and the site still boots',
    async (driver) => {
      const { ref } = await install(driver, { id: 'acme-notes' });
      const evil = buildBundle({ id: 'acme-notes', variant: 'evil' });
      await driver.putBundle(evil, { replacing: ref });
      const report = await driver.boot('managed');
      assertNotRun(report.loaded, evil.label, 'replaced bundle bytes');
      assert.ok(!report.imported.includes(evil.label), 'the replaced bytes are never evaluated');
      assertBooted(report, 'a boot with replaced bytes');
      assertReported(report.issues, 'digest_mismatch', 'replaced bytes');
    },
  );
});

group('managed mode: publishers and ceilings', (scenario) => {
  scenario('an admin install of an unsigned bundle is refused', async (driver) => {
    await driver.boot('managed');
    const ref = await driver.putBundle(buildBundle({ id: 'acme-notes', signedBy: null }));
    const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    assert.equal(outcome.ok, false, 'an unsigned bundle must not install');
  });

  scenario(
    'an admin install from a publisher the config does not trust is refused',
    async (driver) => {
      await driver.boot('managed', { publishers: ['acme'] });
      const ref = await driver.putBundle(
        buildBundle({ id: 'stranger-tool', signedBy: 'stranger' }),
      );
      const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
      assert.equal(outcome.ok, false, 'an untrusted publisher must not install');
    },
  );

  scenario('a publisher cannot release an id outside its namespace', async (driver) => {
    await driver.boot('managed', { publishers: ['acme', 'stranger'] });
    const ref = await driver.putBundle(buildBundle({ id: 'auth-takeover', signedBy: 'acme' }));
    const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    assert.equal(outcome.ok, false, 'an id outside the namespace must not install');
  });

  scenario('an install whose permissions exceed the ceiling is refused', async (driver) => {
    await driver.boot('managed', { ceiling: ['http.routes'] });
    const ref = await driver.putBundle(
      buildBundle({ id: 'acme-spy', permissions: ['http.middleware'] }),
    );
    const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    assert.equal(outcome.ok, false, 'a permission above the ceiling must not install');
  });

  scenario('a stored plugin above a tightened ceiling is skipped at boot', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-spy', permissions: ['http.middleware'] });
    const report = await driver.boot('managed', { ceiling: ['http.routes'] });
    assertNotRun(report.loaded, bundle.label, 'a plugin above the ceiling');
    assertBooted(report, 'a boot with a plugin above the ceiling');
    assertReported(report.issues, 'over_ceiling', 'a plugin above the ceiling');
  });

  scenario('a plugin released under a revoked key stops loading', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const report = await driver.boot('managed', { revoked: [PUBLISHERS.acme.keyId] });
    assertNotRun(report.loaded, bundle.label, 'a release under a revoked key');
    assertBooted(report, 'a boot with a revoked key');
    assertReported(report.issues, 'revoked', 'a revoked key');
  });

  scenario('a catalog whose sequence goes backwards is refused', async (driver) => {
    await driver.boot('managed');
    const newer = await driver.adminAction(OWNER, {
      kind: 'refreshCatalog',
      catalog: buildCatalog(5),
    });
    assert.deepEqual(newer, { ok: true }, 'a signed catalog with a new sequence is accepted');
    const older = await driver.adminAction(OWNER, {
      kind: 'refreshCatalog',
      catalog: buildCatalog(4),
    });
    assert.equal(older.ok, false, 'a catalog rolled back to a lower sequence is refused');
  });
});

group('managed mode: degraded boots and code precedence', (scenario) => {
  scenario('a row whose bundle is missing is skipped and the site still boots', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const ghost = buildBundle({ id: 'acme-ghost', version: '9.9.9' });
    await forge(driver, ghost, true, { withSealKey: true });
    const report = await driver.boot('managed');
    assertBooted(report, 'a boot with a row whose bundle is missing');
    assert.ok(report.loaded.includes(bundle.label), 'the verifiable plugins still run');
    assertReported(report.issues, 'bundle_missing', 'a missing bundle');
  });

  scenario('a required plugin that cannot load fails the boot', async (driver) => {
    const ghost = buildBundle({ id: 'acme-ghost', version: '9.9.9' });
    await forge(driver, ghost, true, { withSealKey: true });
    const report = await driver.boot('managed', { required: ['acme-ghost'] });
    assert.equal(report.booted, false, 'a required plugin that cannot load fails the boot');
  });

  scenario('a code-declared plugin shadows a managed row with the same id', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const report = await driver.boot('managed', { code: ['acme-notes'] });
    assertBooted(report, 'a boot where code and a row declare one id');
    assert.ok(report.loaded.includes('acme-notes@code'), "the app's own plugin runs");
    assertNotRun(report.loaded, bundle.label, 'a row shadowed by code');
    assertReported(report.issues, 'shadowed_by_code', 'a shadowed row');
  });

  scenario('a database row cannot disable a code-declared plugin', async (driver) => {
    const bundle = buildBundle({ id: 'acme-notes' });
    await driver.putBundle(bundle);
    await forge(driver, bundle, false, { withSealKey: true });
    const report = await driver.boot('managed', { code: ['acme-notes'] });
    assertBooted(report, 'a boot with a disabled row for a code plugin');
    assert.ok(report.loaded.includes('acme-notes@code'), "the app's own plugin still runs");
  });

  scenario('safe mode runs code-declared plugins only', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const report = await driver.boot('managed', { safeMode: true, code: ['acme-core'] });
    assertBooted(report, 'a safe-mode boot');
    assert.ok(report.loaded.includes('acme-core@code'), 'code plugins run in safe mode');
    assertNotRun(report.loaded, bundle.label, 'safe mode');
    assert.equal(report.storeCalls, 0, 'safe mode never reads activation state');
  });
});

group('managed mode: admin operations', (scenario) => {
  scenario('an installed plugin loads at the next boot', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const report = await driver.boot('managed');
    assertBooted(report, 'a boot after an install');
    assert.ok(report.loaded.includes(bundle.label), 'the installed plugin runs');
  });

  scenario('installing never evaluates plugin code', async (driver) => {
    const evaluated: string[] = [];
    const slot = globalThis as Record<symbol, BundleRecorder | undefined>;
    slot[RECORDER_KEY] = {
      imported: (label) => evaluated.push(label),
      setup: (label) => evaluated.push(label),
    };
    try {
      await install(driver, { id: 'acme-notes' });
    } finally {
      delete slot[RECORDER_KEY];
    }
    assert.deepEqual(evaluated, [], 'an install runs no plugin code');
  });

  scenario('disable and enable take effect at the next boot', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    await driver.adminAction(OWNER, { kind: 'disable', id: bundle.id });
    assertNotRun((await driver.boot('managed')).loaded, bundle.label, 'a disabled plugin');
    await driver.adminAction(OWNER, { kind: 'enable', id: bundle.id });
    assert.ok((await driver.boot('managed')).loaded.includes(bundle.label), 'it runs again');
  });

  scenario('removing a plugin stops it', async (driver) => {
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const outcome = await driver.adminAction(OWNER, { kind: 'remove', id: bundle.id });
    assert.deepEqual(outcome, { ok: true }, 'the owner can remove a plugin');
    const report = await driver.boot('managed');
    assertBooted(report, 'a boot after a removal');
    assertNotRun(report.loaded, bundle.label, 'a removed plugin');
  });

  scenario('a rollback stops the version it rolled away from', async (driver) => {
    const { bundle: first } = await install(driver, { id: 'acme-notes', version: '1.0.0' });
    const { bundle: second } = await install(driver, { id: 'acme-notes', version: '2.0.0' });
    const outcome = await driver.adminAction(OWNER, {
      kind: 'rollback',
      id: first.id,
      version: first.version,
    });
    assert.deepEqual(outcome, { ok: true }, 'the owner can roll back');
    const report = await driver.boot('managed');
    assert.ok(report.loaded.includes(first.label), 'the version rolled back to runs');
    assertNotRun(report.loaded, second.label, 'the version rolled away from');
  });

  scenario('settings saved by the admin reach the plugin through ctx.settings', async (driver) => {
    const { bundle } = await install(driver, {
      id: 'acme-notes',
      settings: {
        type: 'object',
        properties: { greeting: { type: 'string', title: 'Greeting' } },
      },
    });
    const saved = await driver.adminAction(OWNER, {
      kind: 'settings',
      id: bundle.id,
      values: { greeting: 'hello' },
    });
    assert.deepEqual(saved, { ok: true }, 'the owner can save settings');
    const report = await driver.boot('managed');
    assert.ok(report.loaded.includes(bundle.label), 'the plugin runs');
    assert.deepEqual(
      report.settings[bundle.id],
      { greeting: 'hello' },
      'saved settings must reach ctx.settings.current()',
    );
  });

  scenario(
    'a code-changing action needs authentication within the last 15 minutes',
    async (driver) => {
      await driver.boot('managed');
      const ref = await driver.putBundle(buildBundle({ id: 'acme-notes' }));
      const stale: Actor = { ...OWNER, authenticatedMinutesAgo: 20 };
      const outcome = await driver.adminAction(stale, { kind: 'install', bundle: ref });
      assert.equal(outcome.ok, false, 'an install on a 20-minute-old login must be refused');
    },
  );

  scenario('a bundle that declares autoload is refused', async (driver) => {
    await driver.boot('managed');
    const ref = await driver.putBundle(buildBundle({ id: 'acme-globals', autoload: true }));
    const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    assert.equal(outcome.ok, false, 'a bundle may not declare autoload');
  });

  scenario('an archive that carries a second manifest is refused', async (driver) => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      id: 'acme-twin',
      version: '1.0.0',
      name: 'Twin',
      summary: 'A bundle with a second manifest.',
      publisher: 'acme',
      jsailsCompat: '^1.0.0',
      apiTier: 'stable',
      entry: './index.mjs',
      marketplace: true,
    });
    const bytes = tarGz([
      { name: 'manifest.json', content: manifest },
      { name: 'index.mjs', content: 'export default { name: "acme-twin", setup() {} };\n' },
      { name: 'nested/manifest.json', content: manifest.replace('acme-twin', 'acme-hidden') },
    ]);
    const twin: BuiltBundle = {
      ...buildBundle({ id: 'acme-twin' }),
      bytes,
      digest: sha256(bytes),
    };
    const ref = await driver.putBundle(twin);
    const outcome = await driver.adminAction(OWNER, { kind: 'install', bundle: ref });
    assert.equal(outcome.ok, false, 'one archive is one plugin identity');
  });
});

group('lifecycle across nodes and generations', (scenario) => {
  scenario(
    'every node, including a fresh one with empty storage, runs the installed set',
    async (driver) => {
      const { bundle } = await install(driver, { id: 'acme-notes' });
      const [fresh, other] = await driver.nodes(2);
      assert.ok(fresh !== undefined && other !== undefined, 'the driver adds nodes');
      for (const node of [fresh, other]) {
        const report = await node.boot('managed');
        assertBooted(report, 'a fresh node');
        assert.ok(report.loaded.includes(bundle.label), 'a fresh node converges on the set');
      }
    },
  );

  scenario('a plugin that throws in setup does not take the site down', async (driver) => {
    const { bundle: healthy } = await install(driver, { id: 'acme-notes' });
    const { bundle: broken } = await install(driver, {
      id: 'acme-broken',
      behaviour: 'throws-in-setup',
    });
    const report = await driver.boot('managed');
    assertBooted(report, 'a boot with a plugin that throws in setup');
    assert.ok(report.loaded.includes(healthy.label), 'the other plugins still run');
    assertNotRun(report.loaded, broken.label, 'a plugin whose setup threw');
    const again = await driver.boot('managed');
    assertBooted(again, 'the next boot after the revert');
  });

  scenario('an install applies to the running site without a redeploy', async (driver) => {
    const report = await driver.boot('managed');
    assertBooted(report, 'the running site');
    const { bundle } = await install(driver, { id: 'acme-notes' });
    const { running } = await driver.status();
    assert.ok(running.includes(bundle.label), 'the running site serves the new plugin');
  });
});

/**
 * Every scenario, grouped. A driver's test file declares one `it` per scenario
 * itself (see `legacy.test.ts`), so the runner attributes each result to that
 * file and its expected failures name it.
 */
export const MARKETPLACE_SCENARIOS: readonly ScenarioGroup[] = Object.freeze(groups);

/** Run one scenario against a fresh deployment from `factory`. */
export function runScenario(factory: MarketplaceDriverFactory, scenario: Scenario): Promise<void> {
  return withDeployment(factory, scenario.run);
}
