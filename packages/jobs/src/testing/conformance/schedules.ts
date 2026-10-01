/**
 * Schedules and long timers, under virtual time: an interval or a delay longer
 * than a Node timer can hold fires once at the right time, a paused
 * schedule stays paused when a release reconciles the declared set, a resumed
 * one skips what it missed, and a cron schedule fires on its occurrences.
 */

import assert from 'node:assert/strict';

import { noopJob, type ScenarioGroup } from './scenario.js';

const DAY_MS = 86_400_000;
const MARGIN_MS = 1_000;

export const scheduleScenarios: ScenarioGroup = {
  name: 'schedules',
  scenarios: [
    {
      name: 'a 30-day interval fires once in its first 30 days',
      virtualTime: true,
      async run({ driver, define, log }) {
        define([noopJob('monthly')]);
        await driver.startWorker();
        await driver.reconcileSchedules([
          { id: 'monthly', call: { name: 'monthly', payload: null }, everyMs: 30 * DAY_MS },
        ]);
        await driver.advance(30 * DAY_MS - MARGIN_MS);
        await driver.settle();
        assert.equal(
          log.count('monthly'),
          0,
          `a 30-day interval fired early (${log.count('monthly')} runs)`,
        );
        await driver.advance(2 * MARGIN_MS);
        await driver.settle();
        assert.equal(
          log.count('monthly'),
          1,
          `a 30-day interval fired ${log.count('monthly')} times in its first 30 days; expected once`,
        );
      },
    },
    {
      name: 'a delay longer than a Node timer can hold is honoured',
      virtualTime: true,
      async run({ driver, define, log }) {
        define([noopJob('later')]);
        await driver.startWorker();
        await driver.dispatch({ name: 'later', payload: null }, { delayMs: 25 * DAY_MS });
        await driver.advance(25 * DAY_MS - MARGIN_MS);
        await driver.settle();
        assert.equal(
          log.count('later'),
          0,
          `a 25-day delay ran ${log.count('later')} times before it elapsed`,
        );
        await driver.advance(2 * MARGIN_MS);
        await driver.settle();
        assert.equal(log.count('later'), 1, `a 25-day delay ran ${log.count('later')} times`);
      },
    },
    {
      name: 'a paused schedule stays paused across reconcile',
      virtualTime: true,
      async run({ driver, define, log }) {
        define([noopJob('minutely')]);
        const schedules = [
          { id: 'minutely', call: { name: 'minutely', payload: null }, everyMs: 60_000 },
        ];
        await driver.startWorker();
        await driver.reconcileSchedules(schedules);
        await driver.advance(60_000 + MARGIN_MS);
        await driver.settle();
        assert.equal(log.count('minutely'), 1, 'the schedule did not fire before it was paused');
        await driver.pauseSchedule('minutely');
        await driver.reconcileSchedules(schedules);
        await driver.advance(3 * 60_000);
        await driver.settle();
        assert.equal(
          log.count('minutely') - 1,
          0,
          `a paused schedule fired ${log.count('minutely') - 1} times after reconcile`,
        );
      },
    },
    {
      name: 'a resumed schedule skips the fire times it missed while paused',
      virtualTime: true,
      async run({ driver, define, log }) {
        define([noopJob('minutely')]);
        await driver.startWorker();
        await driver.reconcileSchedules([
          { id: 'minutely', call: { name: 'minutely', payload: null }, everyMs: 60_000 },
        ]);
        await driver.advance(60_000 + MARGIN_MS);
        await driver.settle();
        assert.equal(log.count('minutely'), 1, 'the schedule did not fire before it was paused');
        await driver.pauseSchedule('minutely');
        await driver.advance(3 * 60_000);
        await driver.settle();
        assert.equal(log.count('minutely'), 1, 'a paused schedule fired');
        // Resumed at about 241 s: the slots at 120, 180 and 240 s are skipped,
        // and the next one is at 300 s.
        await driver.resumeSchedule('minutely');
        await driver.advance(30_000);
        await driver.settle();
        assert.equal(
          log.count('minutely') - 1,
          0,
          `a resumed schedule caught up ${log.count('minutely') - 1} missed fires`,
        );
        await driver.advance(30_000 + MARGIN_MS);
        await driver.settle();
        assert.equal(
          log.count('minutely'),
          2,
          `a resumed schedule fired ${log.count('minutely') - 1} times at its next slot`,
        );
      },
    },
    {
      name: 'a cron schedule fires on its occurrences, not at reconcile',
      virtualTime: true,
      async run({ driver, define, log }) {
        define([noopJob('every-minute')]);
        await driver.startWorker();
        await driver.reconcileSchedules([
          {
            id: 'every-minute',
            call: { name: 'every-minute', payload: null },
            cron: '* * * * *',
            timezone: 'UTC',
          },
        ]);
        await driver.settle();
        assert.equal(log.count('every-minute'), 0, 'a cron schedule fired at reconcile');
        // Any 600 s window (s, s + 600 s] holds exactly ten minute boundaries.
        await driver.advance(600_000);
        await driver.settle();
        assert.equal(
          log.count('every-minute'),
          10,
          `a minutely cron schedule fired ${log.count('every-minute')} times in ten minutes`,
        );
      },
    },
  ],
};
