/**
 * The memory adapter's schedules: the stored set, its reconcile stamp and
 * revision, and the firing port the adapter's ticker reads.
 *
 * Pause state lives only here. An applied upsert keeps an existing id's
 * `paused` flag, and keeps its anchor and last fire unless its repeat
 * changed, which re-anchors it at the upsert; a resume moves `through` to
 * now, so the fire times missed while paused are skipped. Every change bumps
 * the record's revision and notifies the ticker. Every operation is
 * synchronous, so each is atomic in the process: an apply compares the set's
 * revision and checks every spec before it writes any.
 */

import type {
  JobEnvelope,
  ReconcileStamp,
  ScheduleCapability,
  ScheduleChange,
  ScheduleSpec,
  StoredSchedule,
  StoredScheduleSet,
} from '../contract/index.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { nextFireAfter, repeatEquals } from '../schedules/fire-times.js';
import {
  checkedScheduleChange,
  checkedScheduleIds,
  MAX_SCHEDULES,
} from '../schedules/schedule-spec.js';
import type { FireExpectation, ScheduleFiringPort, ScheduleRecord } from '../schedules/ticker.js';
import { promised } from './promised.js';

/** What the store needs from its adapter. */
export interface ScheduleHost {
  now(): number;
  hasQueue(queue: string): boolean;
  /** Store a fired envelope on `queue` (a taken key stores nothing). */
  store(queue: string, envelope: JobEnvelope): void;
}

interface MutableRecord {
  spec: ScheduleSpec;
  paused: boolean;
  anchor: number;
  through: number | undefined;
  revision: number;
}

/** Stored schedules and their firing port. */
export class ScheduleStore implements ScheduleCapability {
  readonly #host: ScheduleHost;
  readonly #records = new Map<string, MutableRecord>();
  readonly #listeners = new Set<() => void>();
  #stamp: ReconcileStamp | undefined;
  /** The revision of the stored set: bumped by every apply. */
  #setRevision = 0;
  /** The source of record revisions: bumped by every change to a record. */
  #revision = 0;
  /** The port the adapter's ticker fires through. */
  readonly port: ScheduleFiringPort;

  constructor(host: ScheduleHost) {
    this.#host = host;
    this.port = {
      records: () => this.#snapshot(),
      fire: (id, expected, through, envelope) => this.#fire(id, expected, through, envelope),
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  read(): Promise<StoredScheduleSet> {
    return promised(() =>
      Object.freeze({
        schedules: Object.freeze(
          [...this.#records.values()]
            .sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1))
            .map((record): StoredSchedule =>
              Object.freeze({
                ...record.spec,
                paused: record.paused,
                nextAt: record.paused
                  ? undefined
                  : nextFireAfter(
                      record.spec.repeat,
                      record.anchor,
                      record.through ?? record.anchor,
                    ),
              }),
            ),
        ),
        stamp: this.#stamp,
        revision: this.#setRevision,
      }),
    );
  }

  apply(change: ScheduleChange, expectedRevision: number): Promise<boolean> {
    return promised(() => {
      const {
        specs,
        removed,
        stamp: checked,
      } = checkedScheduleChange(change, expectedRevision, (queue) => this.#host.hasQueue(queue));
      const ids = new Set(specs.map((spec) => spec.id));
      if (expectedRevision !== this.#setRevision) return false;
      const added = [...ids].filter((id) => !this.#records.has(id)).length;
      const dropped = new Set(removed.filter((id) => this.#records.has(id))).size;
      if (this.#records.size + added - dropped > MAX_SCHEDULES)
        throw new JobsErrors.Error('invalid_schedule', { rule: 'too_many' });
      const now = this.#host.now();
      for (const spec of specs) {
        this.#revision += 1;
        const existing = this.#records.get(spec.id);
        if (existing !== undefined && repeatEquals(existing.spec.repeat, spec.repeat)) {
          existing.spec = spec;
          existing.revision = this.#revision;
          continue;
        }
        this.#records.set(spec.id, {
          spec,
          paused: existing?.paused ?? false,
          anchor: now,
          through: undefined,
          revision: this.#revision,
        });
      }
      for (const id of removed) this.#records.delete(id);
      this.#stamp = checked;
      this.#setRevision += 1;
      if (specs.length > 0 || dropped > 0) this.#notify();
      return true;
    });
  }

  setPaused(ids: readonly string[], paused: boolean): Promise<void> {
    return promised(() => {
      const checked = checkedScheduleIds(ids);
      if (typeof paused !== 'boolean') {
        throw new JobsErrors.Error('invalid_schedule', { rule: 'shape' });
      }
      let changed = false;
      for (const id of checked) {
        const record = this.#records.get(id);
        if (record === undefined || record.paused === paused) continue;
        this.#revision += 1;
        record.paused = paused;
        record.revision = this.#revision;
        // A resume skips every fire time it missed while paused.
        if (!paused) record.through = this.#host.now();
        changed = true;
      }
      if (changed) this.#notify();
    });
  }

  #snapshot(): readonly ScheduleRecord[] {
    return Object.freeze([...this.#records.values()].map((record) => Object.freeze({ ...record })));
  }

  #fire(id: string, expected: FireExpectation, through: number, envelope: JobEnvelope): boolean {
    const record = this.#records.get(id);
    if (
      record === undefined ||
      record.paused ||
      record.revision !== expected.revision ||
      record.through !== expected.through
    ) {
      return false;
    }
    record.through = through;
    this.#host.store(record.spec.queue, envelope);
    return true;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
