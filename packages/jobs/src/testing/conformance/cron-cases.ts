/**
 * Cron fire times every evaluator must agree on: each case is a pattern, an
 * IANA time zone, an instant, and the consecutive fires strictly after it,
 * all as `Z` instants.
 *
 * The cases pin the rules that differ between cron implementations: a
 * six-field pattern's seconds, the `@hourly` alias, a leap day years away,
 * a daylight-saving gap (a skipped local time fires at the gap's end), a
 * repeated hour (a fixed local time fires once, at its first occurrence,
 * while a stepped minute field skips the repeated occurrences), weekday
 * ranges across a clock change, and a half-hour offset. A transport that
 * computes fire times itself runs this table against its evaluator; the
 * package's own evaluator is held to it by its tests.
 */

/** One cron pattern's fires after an instant. */
export interface CronFireCase {
  readonly pattern: string;
  readonly tz: string;
  /** The instant the fires are strictly after. */
  readonly after: string;
  /** The consecutive fires, as `Z` instants. */
  readonly fires: readonly string[];
}

export const CRON_FIRE_CASES: readonly CronFireCase[] = Object.freeze([
  {
    pattern: '0 0 * * *',
    tz: 'UTC',
    after: '2023-11-14T22:13:20Z',
    fires: ['2023-11-15T00:00:00Z', '2023-11-16T00:00:00Z'],
  },
  {
    pattern: '*/15 * * * *',
    tz: 'UTC',
    after: '2024-01-01T00:07:00Z',
    fires: ['2024-01-01T00:15:00Z', '2024-01-01T00:30:00Z'],
  },
  {
    pattern: '*/10 * * * * *',
    tz: 'UTC',
    after: '2024-01-01T00:00:05Z',
    fires: ['2024-01-01T00:00:10Z', '2024-01-01T00:00:20Z'],
  },
  {
    pattern: '@hourly',
    tz: 'UTC',
    after: '2024-01-01T00:00:00Z',
    fires: ['2024-01-01T01:00:00Z', '2024-01-01T02:00:00Z'],
  },
  {
    pattern: '0 0 29 2 *',
    tz: 'UTC',
    after: '2024-03-01T00:00:00Z',
    fires: ['2028-02-29T00:00:00Z'],
  },
  {
    pattern: '30 2 * * *',
    tz: 'America/New_York',
    after: '2024-03-09T12:00:00Z',
    fires: ['2024-03-10T07:00:00Z', '2024-03-11T06:30:00Z'],
  },
  {
    pattern: '30 1 * * *',
    tz: 'America/New_York',
    after: '2024-11-02T12:00:00Z',
    fires: ['2024-11-03T05:30:00Z', '2024-11-04T06:30:00Z'],
  },
  {
    pattern: '*/30 * * * *',
    tz: 'America/New_York',
    after: '2024-11-03T05:45:00Z',
    fires: ['2024-11-03T07:00:00Z'],
  },
  {
    pattern: '0 9 * * mon-fri',
    tz: 'Europe/London',
    after: '2024-03-29T10:00:00Z',
    fires: ['2024-04-01T08:00:00Z'],
  },
  {
    pattern: '0 9 * * *',
    tz: 'Asia/Kolkata',
    after: '2024-01-01T00:00:00Z',
    fires: ['2024-01-01T03:30:00Z'],
  },
] satisfies CronFireCase[]);
