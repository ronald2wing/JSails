/**
 * Tests for the jobs dashboard admin page.
 *
 * `defineJobsAdminPage(source)` / `jobsAdmin(source)` render a frozen
 * admin page over an injected {@link JobsDashboardSource}: per-job metrics from
 * `JobMetrics.snapshot()`, recent failures from `FailedJobStore.list()`, and
 * optional live queue counts from `readCounts`. The tests drive the real render
 * path (Preact to string) and assert:
 *
 * - per-job completed/failed counts, average duration, and last error appear in
 *   the metrics table, and viewing the page never resets them: a drained
 *   `snapshot()` folds into a running total, a collector with `peek()` is read
 *   without draining, and only the CSRF-checked reset POST clears the counters;
 * - the failed store renders newest-first and escapes error text;
 * - an absent (or throwing) `readCounts` renders `unavailable` rather than zeros;
 * - the source validator rejects malformed sources value-free, and `jobsPlugin`
 *   reuses it so a miswired `dashboard` fails at construction;
 * - `jobsAdmin` contributes exactly one page, whose only mutation is the reset,
 *   and a panel serves it only to sessions its `authorize` option allows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { Session } from 'jsails';
import {
  InMemoryFailedJobStore,
  InMemoryJobMetrics,
  createJobRegistry,
  defineJob,
  jobsPlugin,
  validateJobsDashboardSource,
  JobsDashboardError,
  type JobMetrics,
  type JobsDashboardSource,
  type QueueCounts,
} from 'jsails/jobs';
import { defineJobsAdminPage, jobsAdmin } from '../src/jobs-dashboard.js';
import type { AdminPage } from '../src/page.js';
import { createAdminTestApp } from './fixtures.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: {},
  expiresAt: 2_000_000_000_000,
};

function renderContext() {
  return {
    session: SESSION,
    path: '/admin',
    request: new Request('http://localhost/admin/jobs'),
    url: new URL('http://localhost/admin/jobs'),
  };
}

/** The post context of the reset form. */
function resetContext() {
  return { ...renderContext(), body: { _csrf: SESSION.csrfToken, action: 'reset' } };
}

/** A dashboard source over counters/failures plus an optional queue reader. */
function buildSource(options?: { counts?: QueueCounts }): {
  source: JobsDashboardSource;
  metrics: InMemoryJobMetrics;
  failed: InMemoryFailedJobStore;
} {
  const metrics = new InMemoryJobMetrics();
  const failed = new InMemoryFailedJobStore();
  const counts = options?.counts;
  const readCounts = counts === undefined ? undefined : async (): Promise<QueueCounts> => counts;
  return {
    source: { metrics, failed, ...(readCounts === undefined ? {} : { readCounts }) },
    metrics,
    failed,
  };
}

/** A `JobMetrics` whose `snapshot()` throws, to exercise the fail-closed path. */
function metricsThatThrow(): JobMetrics {
  return {
    recordCompleted() {},
    recordFailed() {},
    recordWait() {},
    snapshot() {
      throw new Error('boom');
    },
    reset() {},
  };
}

describe('defineJobsAdminPage', () => {
  it('renders per-job metric counts and keeps them across page views', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 150);
    metrics.recordCompleted('sendEmail', 250);
    metrics.recordFailed('sendEmail', new Error('smtp down'));
    metrics.recordCompleted('generateReport', 900);

    const page = defineJobsAdminPage(source);
    const html = await page.render(renderContext());

    assert.match(html, /Job metrics/);
    assert.match(html, />sendEmail</);
    assert.match(html, />generateReport</);
    // completed/failed counts and the average duration (150+250)/2 = 200.
    assert.match(html, /Counters accumulate until reset\./);
    assert.match(html, /smtp down/);
    assert.match(html, />200</);

    // A refresh (or a second admin) sees the same numbers, not an empty table.
    const again = await page.render(renderContext());
    assert.match(again, />sendEmail</);
    assert.match(again, />200</);

    // New runs fold into the running total: (150+250+500)/3 = 300.
    metrics.recordCompleted('sendEmail', 500);
    assert.match(await page.render(renderContext()), />300</);
  });

  it('resets the counters only through the reset POST', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 100);
    const page = defineJobsAdminPage(source);
    const html = await page.render(renderContext());
    assert.match(html, /name="action" value="reset"/);
    assert.match(html, /Reset counters/);

    const response = await page.handlePost!(resetContext());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/jobs');
    assert.match(await page.render(renderContext()), /No jobs recorded since the last reset\./);
  });

  it('keeps the average wait of a drain whose runs have not finished', async () => {
    const { source } = buildSource();
    // Waits are recorded when a run starts, so the first drain has waits but
    // no finished runs; its average must still count in the running total.
    const drains = [
      { sendEmail: { completed: 0, failed: 0, avgDurationMs: 0, avgWaitMs: 40, maxWaitMs: 50 } },
      { sendEmail: { completed: 1, failed: 0, avgDurationMs: 7, avgWaitMs: 20, maxWaitMs: 20 } },
    ];
    const scripted: JobMetrics = {
      recordCompleted() {},
      recordFailed() {},
      recordWait() {},
      snapshot: () => drains.shift() ?? {},
      reset() {},
    };
    const page = defineJobsAdminPage({ ...source, metrics: scripted });
    assert.match(await page.render(renderContext()), /<td>40<\/td><td>50<\/td>/);
    // (40 x 1 + 20 x 1) / 2 = 30, with the maximum wait kept at 50.
    assert.match(await page.render(renderContext()), /<td>30<\/td><td>50<\/td>/);
  });

  it('leaves the core collector intact for another consumer sharing it', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 100);
    const page = defineJobsAdminPage(source);
    assert.match(await page.render(renderContext()), />100</);
    assert.match(await page.render(renderContext()), />100</);
    assert.equal(metrics.snapshot()['sendEmail']?.completed, 1);
  });

  it('reads a collector with peek() without draining it', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 100);
    let snapshots = 0;
    let resets = 0;
    const peekable = {
      ...source,
      metrics: {
        recordCompleted: () => {},
        recordFailed: () => {},
        recordWait: () => {},
        snapshot: () => {
          snapshots += 1;
          return {};
        },
        peek: () => ({
          sendEmail: { completed: 4, failed: 0, avgDurationMs: 42, avgWaitMs: 0, maxWaitMs: 0 },
        }),
        reset: () => {
          resets += 1;
        },
      },
    };
    const page = defineJobsAdminPage(peekable);
    assert.match(await page.render(renderContext()), />42</);
    assert.match(await page.render(renderContext()), />42</);
    assert.equal(snapshots, 0);
    await page.handlePost!(resetContext());
    assert.equal(resets, 1);
  });

  it('renders recent failures newest-first and escapes error text', async () => {
    const { source, failed } = buildSource();
    failed.add({
      id: 'older',
      name: 'sendEmail',
      error: '<script>alert(1)</script>',
      failedAt: new Date('2026-01-01T00:00:00.000Z'),
      attempts: 1,
      tags: ['mail'],
    });
    failed.add({
      id: 'newer',
      name: 'generateReport',
      error: 'disk full',
      failedAt: new Date('2026-01-02T00:00:00.000Z'),
      attempts: 3,
    });

    const html = await defineJobsAdminPage(source).render(renderContext());

    assert.match(html, /Recent failed jobs/);
    // Newest first: generateReport before sendEmail.
    assert.ok(
      html.indexOf('>generateReport<') < html.indexOf('>sendEmail<'),
      'newest failure renders first',
    );
    // Error text is value-free and escaped by Preact's text rendering.
    assert.match(html, /disk full/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script>alert\(1\)&lt;\/script>/);
    // Tags render as admin-tag chips.
    assert.match(html, /admin-tag/);
    assert.match(html, />mail</);
  });

  it('renders queue counts when a reader is injected, unavailable otherwise', async () => {
    const withCounts = buildSource({
      counts: { waiting: 2, active: 1, completed: 10, failed: 3, delayed: 5 },
    });
    const html = await defineJobsAdminPage(withCounts.source).render(renderContext());
    assert.match(html, />Queue</);
    assert.match(html, />Waiting</);
    assert.match(html, />2</);
    assert.match(html, />Delayed</);
    assert.match(html, />5</);

    const withoutCounts = buildSource();
    const noCountsHtml = await defineJobsAdminPage(withoutCounts.source).render(renderContext());
    assert.match(noCountsHtml, /Queue counts are unavailable/);
  });

  it('fails closed to an unavailable note when a read throws', async () => {
    const { source } = buildSource();
    // A metrics collector whose snapshot() throws: the section degrades, never 500s.
    const throwing = defineJobsAdminPage({
      metrics: metricsThatThrow(),
      failed: source.failed,
    });
    const html = await throwing.render(renderContext());
    assert.match(html, /Job metrics are unavailable\./);

    // A throwing readCounts reader degrades the queue section.
    const throwingCounts = defineJobsAdminPage({
      metrics: source.metrics,
      failed: source.failed,
      readCounts: async () => {
        throw new Error('boom');
      },
    });
    const countsHtml = await throwingCounts.render(renderContext());
    assert.match(countsHtml, /Queue counts are unavailable/);
  });

  it('ignores a POST that is not the reset', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 100);
    const page = defineJobsAdminPage(source);
    assert.equal(page.slug, 'jobs');
    assert.equal(page.label, 'Jobs');
    await page.render(renderContext());
    const response = await page.handlePost!({ ...renderContext(), body: { action: 'other' } });
    assert.equal(response.status, 303);
    assert.match(await page.render(renderContext()), />sendEmail</);
  });
});

describe('jobsAdmin', () => {
  it('contributes exactly one jobs page through the admin plugin builder', () => {
    const pages: AdminPage[] = [];
    jobsAdmin(buildSource().source).register({
      addPage(page) {
        pages.push(page);
      },
      addNavigationItem() {},
      addResource() {},
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.slug, 'jobs');
    assert.equal(typeof pages[0]!.handlePost, 'function');
  });

  it('is reachable through a panel only with an authorize gate', async () => {
    const ungated = await createAdminTestApp({ adminPlugins: [jobsAdmin(buildSource().source)] });
    assert.equal((await ungated.request('/admin/jobs')).status, 403);
    await ungated.close();

    const seen: string[] = [];
    const gated = await createAdminTestApp({
      adminPlugins: [
        jobsAdmin(buildSource().source, {
          authorize: ({ session }) => {
            seen.push(session.id);
            return true;
          },
        }),
      ],
    });
    const response = await gated.request('/admin/jobs');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Job metrics/);
    assert.ok(seen.length > 0);
    await gated.close();
  });
});

describe('validateJobsDashboardSource', () => {
  it('accepts a valid source (metrics + failed, readCounts optional)', () => {
    const { source } = buildSource();
    validateJobsDashboardSource(source);
    validateJobsDashboardSource({
      ...source,
      readCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    });
  });

  it('rejects malformed sources value-free', () => {
    const { source } = buildSource();
    assert.throws(() => validateJobsDashboardSource(null), JobsDashboardError);
    assert.throws(() => validateJobsDashboardSource([]), JobsDashboardError);
    assert.throws(() => validateJobsDashboardSource({}), JobsDashboardError);
    assert.throws(
      () => validateJobsDashboardSource({ metrics: {}, failed: source.failed }),
      JobsDashboardError,
    );
    assert.throws(
      () => validateJobsDashboardSource({ metrics: source.metrics, failed: {} }),
      JobsDashboardError,
    );
    assert.throws(
      () => validateJobsDashboardSource({ ...source, readCounts: 'nope' }),
      JobsDashboardError,
    );
  });
});

describe('jobsPlugin dashboard option', () => {
  const registry = createJobRegistry({
    sendEmail: defineJob(z.object({ to: z.string() }), async () => undefined),
  });

  it('accepts a valid dashboard source and rejects a malformed one at construction', () => {
    const { source } = buildSource();
    // Valid: constructs without throwing.
    assert.ok(jobsPlugin({ registry, dashboard: source }));

    assert.throws(() => jobsPlugin({ registry, dashboard: null } as never), JobsDashboardError);
    assert.throws(
      () => jobsPlugin({ registry, dashboard: { metrics: {}, failed: {} } } as never),
      JobsDashboardError,
    );
  });
});
