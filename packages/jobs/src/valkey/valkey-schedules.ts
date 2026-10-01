/**
 * Schedules on the Valkey transport, stored by the transport and fired by
 * the package's schedule ticker in every process that runs a worker.
 *
 * The stored set is six hashes keyed by schedule id (the spec as JSON, its
 * canonical repeat, the pause flag, the anchor, the last fire, the record
 * revision) and a meta hash (the set revision, the reconcile stamp, a record
 * revision counter, and a change counter). Specs are stored and read back as
 * JSON strings, never decoded in Lua, so a payload's numbers keep their
 * precision.
 *
 * - `apply` is one compare-and-set script on the set revision, holding the
 *   memory adapter's rules: a new id starts unpaused and anchored now, an
 *   existing id keeps its pause flag, and keeps its anchor and last fire
 *   unless its repeat changed.
 * - `setPaused` is one script; a resume moves the last fire to now, so the
 *   fire times missed while paused are skipped.
 * - A fire is checked against the ticker's expectation (revision, last
 *   fire, unpaused) in one script, then enqueued with the fire's own key,
 *   then recorded by a compare-and-set on the same expectation. Enqueueing
 *   before recording means a fire is never lost to a crash between the two;
 *   two processes firing one slot enqueue it once, by its key; a fire that
 *   races a pause or a reconcile between its check and its record may still
 *   run once.
 * - Every apply and pause bumps the change counter. A process that fires
 *   reads it every `scheduleSyncMs` of real time (whatever clock the
 *   schedules run on: the counter tracks other processes, not fire times)
 *   and refreshes its ticker when it moved, so a reconcile or a pause made
 *   elsewhere reaches it; a change made here refreshes at once.
 * - Firing runs between `startFiring` and `stopFiring`. Once stopped, a fire
 *   whose check already passed enqueues nothing (it records nothing either,
 *   so another process fires the slot), and `stopFiring` resolves only once
 *   every read and fire the ticker started has finished, so nothing of them
 *   reaches the server after the adapter closed.
 */

import type {
  JobEnvelope,
  ReconcileStamp,
  ScheduleCapability,
  ScheduleChange,
  ScheduleRepeat,
  ScheduleSpec,
  StoredSchedule,
  StoredScheduleSet,
} from '../contract/index.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { nextFireAfter } from '../schedules/fire-times.js';
import {
  checkedScheduleChange,
  checkedScheduleIds,
  MAX_SCHEDULES,
} from '../schedules/schedule-spec.js';
import type { FireExpectation, ScheduleFiringPort, ScheduleRecord } from '../schedules/ticker.js';
import {
  setLongTimeout,
  systemClock,
  type JobsClock,
  type LongTimer,
} from '../timing/long-timer.js';
import type { KeyLayout } from './key-layout.js';
import { guarded, transportError } from './transport-error.js';
import type { ValkeyScripts } from './valkey-scripts.js';

/** What the schedules need from their adapter. */
export interface ScheduleHost {
  readonly scripts: ValkeyScripts;
  readonly layout: KeyLayout;
  readonly clock: JobsClock;
  readonly scheduleSyncMs: number;
  hasQueue(queue: string): boolean;
  /** Store a fired envelope as `enqueue` stores a job (a taken key stores nothing). */
  enqueue(queue: string, envelope: JobEnvelope): Promise<unknown>;
  report(error: Error): void;
}

interface Watch {
  timer: LongTimer | undefined;
  reading: Promise<void> | undefined;
  seen: string | undefined;
  stopped: boolean;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A flat `HGETALL` reply as a map. */
function hashOf(reply: unknown): Map<string, string> {
  const flat = asArray(reply);
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(asText(flat[i]), asText(flat[i + 1]));
  return map;
}

/** One string per repeat, equal exactly when `repeatEquals` holds. */
function canonicalRepeat(repeat: ScheduleRepeat): string {
  return 'everyMs' in repeat
    ? JSON.stringify({ everyMs: repeat.everyMs })
    : JSON.stringify({ cron: repeat.cron, tz: repeat.tz });
}

/** The stored schedules of one adapter and their firing port. */
export class ValkeySchedules implements ScheduleCapability {
  readonly port: ScheduleFiringPort;
  readonly #host: ScheduleHost;
  readonly #listeners = new Set<() => void>();
  readonly #keys: readonly string[];
  /** The ticker's reads and fires still running. */
  readonly #working = new Set<Promise<unknown>>();
  #watch: Watch | undefined;

  constructor(host: ScheduleHost) {
    this.#host = host;
    const { layout } = host;
    this.#keys = [
      layout.schedules('spec'),
      layout.schedules('repeat'),
      layout.schedules('paused'),
      layout.schedules('anchor'),
      layout.schedules('through'),
      layout.schedules('rev'),
      layout.scheduleMeta,
    ];
    this.port = {
      records: () => this.#tracked(this.#records()),
      fire: (id, expected, through, envelope) =>
        this.#tracked(this.#fire(id, expected, through, envelope)),
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  #tracked<T>(work: Promise<T>): Promise<T> {
    this.#working.add(work);
    const done = (): void => {
      this.#working.delete(work);
    };
    work.then(done, done);
    return work;
  }

  /**
   * Resolve once no read or fire the ticker started is running, its
   * reactions included, so a test moving a virtual clock never moves past a
   * fire still on its way to the server.
   */
  async idle(): Promise<void> {
    let quiet = 0;
    while (quiet < 2) {
      if (this.#working.size > 0) {
        quiet = 0;
        // Each tracked promise is also awaited by the ticker, which reports its failure.
        await Promise.allSettled([...this.#working]);
      } else {
        quiet += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  #key(index: number): string {
    return this.#keys[index]!;
  }

  async #snapshot(): Promise<{
    readonly records: readonly ScheduleRecord[];
    readonly revision: number;
    readonly stamp: ReconcileStamp | undefined;
  }> {
    const reply = asArray(await guarded(() => this.#host.scripts.scheduleRead.run(this.#keys, [])));
    const [specs, paused, anchors, throughs, revisions] = [0, 1, 2, 3, 4].map((i) =>
      hashOf(reply[i]),
    ) as [
      Map<string, string>,
      Map<string, string>,
      Map<string, string>,
      Map<string, string>,
      Map<string, string>,
    ];
    const records = [...specs]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, json]): ScheduleRecord => {
        const through = throughs.get(id);
        return Object.freeze({
          spec: JSON.parse(json) as ScheduleSpec,
          paused: paused.get(id) === '1',
          anchor: Number(anchors.get(id)),
          through: through === undefined ? undefined : Number(through),
          revision: Number(revisions.get(id)),
        });
      });
    const stamp = asText(reply[6]);
    return {
      records: Object.freeze(records),
      revision: Number(asText(reply[5]) || '0'),
      stamp: stamp === '' ? undefined : (Object.freeze(JSON.parse(stamp)) as ReconcileStamp),
    };
  }

  async #records(): Promise<readonly ScheduleRecord[]> {
    return (await this.#snapshot()).records;
  }

  async read(): Promise<StoredScheduleSet> {
    const { records, revision, stamp } = await this.#snapshot();
    const schedules = records.map((record): StoredSchedule =>
      Object.freeze({
        ...record.spec,
        paused: record.paused,
        nextAt: record.paused
          ? undefined
          : nextFireAfter(record.spec.repeat, record.anchor, record.through ?? record.anchor),
      }),
    );
    return Object.freeze({ schedules: Object.freeze(schedules), stamp, revision });
  }

  async apply(change: ScheduleChange, expectedRevision: number): Promise<boolean> {
    const { specs, removed, stamp } = checkedScheduleChange(change, expectedRevision, (queue) =>
      this.#host.hasQueue(queue),
    );
    const args: (string | number)[] = [
      expectedRevision,
      this.#host.clock.now(),
      MAX_SCHEDULES,
      JSON.stringify(stamp),
      specs.length,
    ];
    for (const spec of specs)
      args.push(spec.id, JSON.stringify(spec), canonicalRepeat(spec.repeat));
    args.push(...removed);
    const reply = await guarded(() => this.#host.scripts.scheduleApply.run(this.#keys, args));
    if (reply === -1) throw new JobsErrors.Error('invalid_schedule', { rule: 'too_many' });
    if (reply !== 1) return false;
    this.#notify();
    return true;
  }

  async setPaused(ids: readonly string[], paused: boolean): Promise<void> {
    const checked = checkedScheduleIds(ids);
    if (typeof paused !== 'boolean') {
      throw new JobsErrors.Error('invalid_schedule', { rule: 'shape' });
    }
    if (checked.length === 0) return;
    await guarded(() =>
      this.#host.scripts.schedulePause.run(
        [this.#key(0), this.#key(2), this.#key(4), this.#key(5), this.#key(6)],
        [paused ? '1' : '0', this.#host.clock.now(), ...checked],
      ),
    );
    this.#notify();
  }

  async #fire(
    id: string,
    expected: FireExpectation,
    through: number,
    envelope: JobEnvelope,
  ): Promise<boolean> {
    const keys = [this.#key(0), this.#key(2), this.#key(5), this.#key(4)];
    const expectation = [
      id,
      expected.revision,
      expected.through === undefined ? '' : expected.through,
      through,
    ];
    const spec = asText(
      await guarded(() => this.#host.scripts.scheduleFire.run(keys, [...expectation, '0'])),
    );
    if (spec === '') return false;
    // Stopped while checking: leave the slot unfired for whichever process fires next.
    if (this.#watch === undefined) return false;
    const { queue } = JSON.parse(spec) as ScheduleSpec;
    await this.#host.enqueue(queue, envelope);
    const recorded = await guarded(() =>
      this.#host.scripts.scheduleFire.run(keys, [...expectation, '1']),
    );
    return recorded === 1;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Let fires through and read the change counter every `scheduleSyncMs`. Idempotent. */
  startFiring(): void {
    if (this.#watch !== undefined) return;
    const watch: Watch = { timer: undefined, reading: undefined, seen: undefined, stopped: false };
    this.#watch = watch;
    this.#next(watch);
  }

  /**
   * Stop letting fires through and reading the change counter; resolves once
   * the counter read and every read and fire the ticker started finished.
   * The caller stops its ticker first, so none starts after.
   */
  async stopFiring(): Promise<void> {
    const watch = this.#watch;
    this.#watch = undefined;
    if (watch !== undefined) {
      watch.stopped = true;
      watch.timer?.cancel();
      await watch.reading;
    }
    await this.idle();
  }

  #next(watch: Watch): void {
    watch.timer = setLongTimeout(
      () => {
        watch.timer = undefined;
        if (!watch.stopped) watch.reading = this.#poll(watch);
      },
      this.#host.scheduleSyncMs,
      systemClock,
    );
  }

  /** One read of the change counter; never rejects. */
  async #poll(watch: Watch): Promise<void> {
    try {
      const changes = asText(
        await this.#host.scripts.scheduleChanges.run([this.#host.layout.scheduleMeta], []),
      );
      if (watch.stopped) return;
      // The first read refreshes too: a change made between the ticker's
      // first read and this one would otherwise wait for the next change.
      if (changes !== watch.seen) {
        watch.seen = changes;
        this.#notify();
      }
    } catch (error) {
      this.#host.report(transportError(error));
    } finally {
      watch.reading = undefined;
      if (!watch.stopped) this.#next(watch);
    }
  }
}
