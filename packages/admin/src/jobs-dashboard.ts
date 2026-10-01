/**
 * Jobs dashboard: a read-only admin page over worker-owned job observability.
 *
 * `defineJobsAdminPage(source)` builds a validated {@link AdminPage}
 * descriptor (slug `jobs`, label `Jobs`) whose `render` reads the injected
 * {@link JobsDashboardSource} and renders three sections:
 *
 * - **Job metrics** — per-job `completed`/`failed` counts, average duration,
 *   average and maximum wait, and the most recent error message. Viewing the
 *   page never resets anything: a collector that offers a non-destructive
 *   `peek()` is read through it; otherwise each `snapshot()` (which drains the
 *   collector) is folded into a running total the page owns, so a refresh or a
 *   second admin sees the same numbers. Counters reset only through the page's
 *   CSRF-checked "Reset counters" POST.
 * - **Recent failed jobs** — the newest-to-oldest entries from
 *   `FailedJobStore.list()` (the store is already bounded by its own `maxEntries`,
 *   so `list()` needs no further limit).
 * - **Queue counts** — the waiting/active/completed/failed/delayed totals from
 *   the optional `readCounts` reader (the runtime's transport capability). When
 *   the source has no `readCounts`, the section renders `unavailable` rather than
 *   inventing zeros.
 *
 * `jobsAdmin(source)` wraps that page in an {@link AdminPlugin} (id
 * `jobs-dashboard`) so it composes into `defineAdminPanel({ adminPlugins })`
 * exactly like the first-party plugin manager. Its only mutation is the reset
 * POST; as a normal admin page, the panel's existing default-deny
 * authorization, same-origin, and CSRF gates already apply to it — this module
 * re-adds none of them.
 *
 * Fail-closed by construction: `metrics` and `failed` are required by the source
 * contract (`validateJobsDashboardSource`), and a throwing read (metrics/stores/
 * counts) degrades to an explicit `unavailable` note instead of a 500. The page
 * shows only what the application passed in.
 */

import { h, type ComponentChild } from 'preact';
import {
  validateJobsDashboardSource,
  type FailedJobEntry,
  type JobMetricsSnapshot,
  type JobsDashboardSource,
  type QueueCounts,
} from 'jsails/jobs';

import { defineAdminPlugin, type AdminPlugin } from './admin-plugin.js';
import {
  adminRedirectResponse,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
} from './document.js';
import { actionForm } from './forms.js';
import { defineAdminPage, type AdminPage, type AdminPageRenderContext } from './page.js';

/** Per-job metrics keyed by job name. */
type MetricsTable = Readonly<Record<string, JobMetricsSnapshot>>;

/** A collector that can be read without draining it. */
interface PeekableMetrics {
  peek(): MetricsTable;
}

/** The admin page slug and label for the jobs dashboard. */
const PAGE_SLUG = 'jobs';
const PAGE_LABEL = 'Jobs';

/** Build the jobs dashboard {@link AdminPage} over an injected source. */
export function defineJobsAdminPage(source: JobsDashboardSource): AdminPage {
  validateJobsDashboardSource(source);
  const reader = createMetricsReader(source);
  return defineAdminPage({
    slug: PAGE_SLUG,
    label: PAGE_LABEL,
    render: (context) => renderJobsDashboard(context, source, reader),
    handlePost: (context) => {
      if (context.body['action'] === 'reset') {
        reader.reset();
      }
      return adminRedirectResponse(`${context.path}/${PAGE_SLUG}`);
    },
  });
}

/** Reads the metrics without resetting them, and resets them on request. */
interface MetricsReader {
  read(): MetricsTable | undefined;
  reset(): void;
}

/**
 * Prefer the collector's non-destructive `peek()`. Without one, `snapshot()`
 * drains the collector, so every drained snapshot is folded into a running
 * total this page keeps; the page then shows the same numbers to every reader.
 */
function createMetricsReader(source: JobsDashboardSource): MetricsReader {
  const metrics: unknown = source.metrics;
  if (isPeekable(metrics)) {
    return {
      read: () => {
        try {
          return metrics.peek();
        } catch {
          return undefined;
        }
      },
      reset: () => source.metrics.reset(),
    };
  }
  let total: Record<string, JobMetricsSnapshot> = {};
  // A snapshot carries no wait-sample count, so each job's running average
  // wait keeps its own estimated weight (see `waitWeight`).
  let waitWeights: Record<string, number> = {};
  return {
    read: () => {
      let drained: MetricsTable;
      try {
        drained = source.metrics.snapshot();
      } catch {
        return undefined;
      }
      for (const [name, entry] of Object.entries(drained)) {
        const previous = total[name];
        const previousWeight = waitWeights[name] ?? 0;
        const weight = waitWeight(entry);
        total[name] =
          previous === undefined ? entry : mergeSnapshots(previous, entry, previousWeight, weight);
        waitWeights[name] = previousWeight + weight;
      }
      return { ...total };
    },
    reset: () => {
      total = {};
      waitWeights = {};
      source.metrics.reset();
    },
  };
}

/** Whether a collector offers a non-destructive `peek()`. */
function isPeekable(metrics: unknown): metrics is PeekableMetrics {
  return (
    typeof metrics === 'object' &&
    metrics !== null &&
    typeof (metrics as { peek?: unknown }).peek === 'function'
  );
}

/**
 * The estimated number of wait samples behind a drained snapshot's average
 * wait. Waits are recorded when a run starts, so a drain can hold waits for
 * runs that have not finished: with no finished runs but a recorded wait it
 * still counts as one sample instead of being weighted away.
 */
function waitWeight(entry: JobMetricsSnapshot): number {
  const runs = entry.completed + entry.failed;
  if (runs > 0) return runs;
  return entry.avgWaitMs > 0 || entry.maxWaitMs > 0 ? 1 : 0;
}

/**
 * Fold a newer drained snapshot into the running total. Average durations are
 * weighted by completions; average waits by the estimated wait samples
 * (`waitWeight`) the caller tracks for each side.
 */
function mergeSnapshots(
  older: JobMetricsSnapshot,
  newer: JobMetricsSnapshot,
  olderWaitWeight: number,
  newerWaitWeight: number,
): JobMetricsSnapshot {
  const completed = older.completed + newer.completed;
  const failed = older.failed + newer.failed;
  const lastError = newer.lastError ?? older.lastError;
  const byTag = mergeTags(older.byTag, newer.byTag);
  return {
    completed,
    failed,
    avgDurationMs: weightedMean(
      older.avgDurationMs,
      older.completed,
      newer.avgDurationMs,
      newer.completed,
    ),
    avgWaitMs: weightedMean(older.avgWaitMs, olderWaitWeight, newer.avgWaitMs, newerWaitWeight),
    maxWaitMs: Math.max(older.maxWaitMs, newer.maxWaitMs),
    ...(lastError === undefined ? {} : { lastError }),
    ...(byTag === undefined ? {} : { byTag }),
  };
}

/** The mean of two means weighted by their sample counts (0 with no samples). */
function weightedMean(left: number, leftCount: number, right: number, rightCount: number): number {
  const count = leftCount + rightCount;
  return count === 0 ? 0 : (left * leftCount + right * rightCount) / count;
}

/** Sum two per-tag breakdowns; absent when neither has one. */
function mergeTags(
  older: JobMetricsSnapshot['byTag'],
  newer: JobMetricsSnapshot['byTag'],
): JobMetricsSnapshot['byTag'] {
  if (older === undefined) return newer;
  if (newer === undefined) return older;
  const merged: Record<string, { completed: number; failed: number }> = {};
  for (const [tag, counts] of [...Object.entries(older), ...Object.entries(newer)]) {
    const current = merged[tag] ?? { completed: 0, failed: 0 };
    merged[tag] = {
      completed: current.completed + counts.completed,
      failed: current.failed + counts.failed,
    };
  }
  return merged;
}

/** Build a jobs dashboard {@link AdminPlugin} contributing the dashboard page. */
export function jobsAdmin(source: JobsDashboardSource): AdminPlugin {
  return defineAdminPlugin({
    id: 'jobs-dashboard',
    register(builder) {
      builder.addPage(defineJobsAdminPage(source));
    },
  });
}

/**
 * Render the full dashboard document. Every section is read once and rendered
 * from the returned value; the failed store's `list()` is reversed newest-first
 * for display only.
 */
async function renderJobsDashboard(
  context: AdminPageRenderContext,
  source: JobsDashboardSource,
  reader: MetricsReader,
): Promise<string> {
  const body: ComponentChild[] = [
    h('h1', null, PAGE_LABEL),
    renderMetricsSection(reader.read()),
    actionForm({
      path: `${context.path}/${PAGE_SLUG}`,
      csrf: context.session.csrfToken,
      label: 'Reset counters',
      action: 'reset',
    }),
    renderQueueSection(await readQueueCounts(source)),
    renderFailedSection(readFailed(source)),
    h('a', { href: context.path }, 'Back to dashboard'),
  ];

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, PAGE_LABEL), ...body);
}

/** Read the recent failures, newest first. The store is already size-bounded. */
function readFailed(source: JobsDashboardSource): readonly FailedJobEntry[] | undefined {
  try {
    return [...source.failed.list()].reverse();
  } catch {
    return undefined;
  }
}

/** Resolve the queue-counts section result: absent reader or a throw ⇒ unavailable. */
async function readQueueCounts(source: JobsDashboardSource): Promise<QueueCounts | undefined> {
  if (source.readCounts === undefined) {
    return undefined;
  }
  try {
    return await source.readCounts();
  } catch {
    return undefined;
  }
}

/** The per-job metrics table, or an explicit empty/unavailable note. */
function renderMetricsSection(snapshot: MetricsTable | undefined): ComponentChild {
  const heading = h('h2', null, 'Job metrics');
  if (snapshot === undefined) {
    return h('section', null, heading, h('p', null, 'Job metrics are unavailable.'));
  }
  const rows = Object.entries(snapshot);
  if (rows.length === 0) {
    return h('section', null, heading, h('p', null, 'No jobs recorded since the last reset.'));
  }
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return h(
    'section',
    null,
    heading,
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Job'),
          h('th', null, 'Completed'),
          h('th', null, 'Failed'),
          h('th', null, 'Avg duration (ms)'),
          h('th', null, 'Avg wait (ms)'),
          h('th', null, 'Max wait (ms)'),
          h('th', null, 'Last error'),
        ),
      ),
      h(
        'tbody',
        null,
        ...rows.map(([name, entry]) =>
          h(
            'tr',
            null,
            h('td', null, name),
            h('td', null, String(entry.completed)),
            h('td', null, String(entry.failed)),
            h('td', null, String(entry.avgDurationMs)),
            h('td', null, String(entry.avgWaitMs)),
            h('td', null, String(entry.maxWaitMs)),
            h('td', null, entry.lastError ?? ''),
          ),
        ),
      ),
    ),
    h('p', null, 'Counters accumulate until reset.'),
  );
}

/** The live queue totals, or an explicit unavailable note. */
function renderQueueSection(counts: QueueCounts | undefined): ComponentChild {
  const heading = h('h2', null, 'Queue');
  if (counts === undefined) {
    return h(
      'section',
      null,
      heading,
      h('p', null, 'Queue counts are unavailable (no queue count provider).'),
    );
  }
  const cells: Array<readonly [string, number]> = [
    ['Waiting', counts.waiting],
    ['Active', counts.active],
    ['Completed', counts.completed],
    ['Failed', counts.failed],
    ['Delayed', counts.delayed],
  ];
  return h(
    'section',
    null,
    heading,
    h(
      'dl',
      null,
      ...cells.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, String(value))]),
    ),
  );
}

/** The recent failures table, newest first, or an explicit empty/unavailable note. */
function renderFailedSection(entries: readonly FailedJobEntry[] | undefined): ComponentChild {
  const heading = h('h2', null, 'Recent failed jobs');
  if (entries === undefined) {
    return h('section', null, heading, h('p', null, 'Recent failures are unavailable.'));
  }
  if (entries.length === 0) {
    return h('section', null, heading, h('p', null, 'No recent failures.'));
  }
  return h(
    'section',
    null,
    heading,
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Failed at'),
          h('th', null, 'Job'),
          h('th', null, 'Attempts'),
          h('th', null, 'Error'),
          h('th', null, 'Tags'),
        ),
      ),
      h(
        'tbody',
        null,
        ...entries.map((entry) =>
          h(
            'tr',
            null,
            h('td', { class: 'admin-date' }, entry.failedAt.toISOString()),
            h('td', null, entry.name),
            h('td', null, String(entry.attempts)),
            h('td', null, entry.error),
            h(
              'td',
              null,
              ...(entry.tags ?? []).map((tag) => h('span', { class: 'admin-tag' }, tag)),
            ),
          ),
        ),
      ),
    ),
  );
}
