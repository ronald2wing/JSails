/**
 * Time zones through `Intl`: canonical zone names, wall-clock fields and
 * offsets of an instant, and the instant of a wall time, exact, in a
 * daylight-saving gap (the gap's end) or repeated (its first occurrence).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canonicalTimeZone,
  instantOf,
  offsetAt,
  utcFields,
  utcOf,
  zonedFields,
} from '../../src/schedules/time-zone.js';

const HOUR_MS = 3_600_000;

describe('time zones', () => {
  test('canonical names, and nothing for an unknown or malformed zone', () => {
    assert.equal(canonicalTimeZone('UTC'), 'UTC');
    assert.equal(canonicalTimeZone('America/New_York'), 'America/New_York');
    assert.equal(canonicalTimeZone('america/new_york'), 'America/New_York');
    for (const value of ['Mars/Olympus', '', 'x'.repeat(65), 7, undefined]) {
      assert.equal(canonicalTimeZone(value), undefined, String(value));
    }
  });

  test('utcOf and utcFields are inverse, years before 100 included', () => {
    const local = { year: 50, month: 2, day: 28, hour: 23, minute: 59, second: 58 };
    const instant = utcOf(local);
    assert.deepEqual(utcFields(instant), { ...local, weekday: new Date(instant).getUTCDay() });
  });

  test('zonedFields reads the wall clock of a zone, weekday included', () => {
    const instant = Date.parse('2024-03-10T07:30:00Z');
    assert.deepEqual(zonedFields(instant, 'America/New_York'), {
      year: 2024,
      month: 3,
      day: 10,
      hour: 3,
      minute: 30,
      second: 0,
      weekday: 0,
    });
    assert.deepEqual(zonedFields(instant, 'UTC'), utcFields(instant));
    assert.equal(zonedFields(Date.parse('2024-01-01T00:00:00Z'), 'Asia/Kolkata').hour, 5);
  });

  test('offsetAt follows daylight saving and half-hour zones', () => {
    assert.equal(offsetAt(Date.parse('2024-01-15T12:00:00Z'), 'America/New_York'), -5 * HOUR_MS);
    assert.equal(
      offsetAt(Date.parse('2024-07-15T12:00:00.250Z'), 'America/New_York'),
      -4 * HOUR_MS,
    );
    assert.equal(offsetAt(Date.parse('2024-07-15T12:00:00Z'), 'Asia/Kolkata'), 5.5 * HOUR_MS);
    assert.equal(offsetAt(0, 'UTC'), 0);
  });

  test('instantOf resolves exact, gap and repeated wall times', () => {
    const at = (year: number, month: number, day: number, hour: number, minute: number) => ({
      year,
      month,
      day,
      hour,
      minute,
      second: 0,
    });
    const ny = 'America/New_York';
    assert.deepEqual(instantOf(at(2024, 1, 15, 9, 0), ny), {
      instant: Date.parse('2024-01-15T14:00:00Z'),
      kind: 'exact',
    });
    assert.deepEqual(instantOf(at(2024, 3, 10, 2, 30), ny), {
      instant: Date.parse('2024-03-10T07:00:00Z'),
      kind: 'gap',
    });
    assert.deepEqual(instantOf(at(2024, 11, 3, 1, 30), ny), {
      instant: Date.parse('2024-11-03T05:30:00Z'),
      kind: 'ambiguous',
    });
    assert.deepEqual(instantOf(at(2024, 11, 3, 1, 30), 'UTC'), {
      instant: Date.parse('2024-11-03T01:30:00Z'),
      kind: 'exact',
    });
    assert.deepEqual(instantOf(at(2024, 3, 31, 1, 15), 'Europe/London'), {
      instant: Date.parse('2024-03-31T01:00:00Z'),
      kind: 'gap',
    });
  });
});
