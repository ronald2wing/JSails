/**
 * Local cron-pattern validation, so `prepareSchedules` rejects a bad pattern
 * before any schedule is written to the provider.
 *
 * It follows the grammar of `cron-parser` (the parser BullMQ uses): an
 * optional seconds field plus the five classic fields (missing leading fields
 * default, as there), month and weekday names, ranges, steps, lists, `?`, and
 * the predefined `@` aliases. It is deliberately permissive about the
 * provider-specific extensions (`L`, `#`, hashed `H`): those are checked for
 * their character set only and left to the provider, so a pattern this module
 * rejects is one the provider would reject too.
 */

/** The predefined aliases `cron-parser` accepts (exact, lowercase). */
const PREDEFINED = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@hourly',
  '@minutely',
  '@secondly',
  '@weekdays',
  '@weekends',
]);

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

const DAY_NAMES: Readonly<Record<string, number>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly chars: RegExp;
  readonly names?: Readonly<Record<string, number>>;
}

const PLAIN_CHARS = /^[?,*\dH/-]+$/;

/** Seconds, minutes, hours, day of month, month, day of week. */
const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59, chars: PLAIN_CHARS },
  { min: 0, max: 59, chars: PLAIN_CHARS },
  { min: 0, max: 23, chars: PLAIN_CHARS },
  { min: 1, max: 31, chars: /^[?,*\dLH/-]+$/ },
  { min: 1, max: 12, chars: PLAIN_CHARS, names: MONTH_NAMES },
  { min: 0, max: 7, chars: /^[?,*\dLH#/-]+$/, names: DAY_NAMES },
];

const FIELD_DEFAULTS = ['0', '*', '*', '*', '*', '*'];

/** Upper bound on a pattern's length (the provider's own limit). */
const MAX_PATTERN_LENGTH = 1024;

/** Whether `pattern` is a cron expression the provider can parse. */
export function isValidCronPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  const trimmed = pattern.trim();
  if (trimmed.startsWith('@')) return PREDEFINED.has(trimmed);
  const atoms = trimmed.split(/\s+/);
  if (atoms.length === 0 || atoms.length > FIELDS.length) return false;
  const fields = [...FIELD_DEFAULTS.slice(0, FIELDS.length - atoms.length), ...atoms];
  return fields.every((field, index) => {
    const spec = FIELDS[index];
    return spec !== undefined && isValidField(field, spec);
  });
}

function isValidField(raw: string, spec: FieldSpec): boolean {
  let value = raw;
  if (spec.names !== undefined) {
    const names = spec.names;
    let unknownName = false;
    value = value.replace(/[a-z]{3}/gi, (match) => {
      const number = names[match.toLowerCase()];
      if (number === undefined) {
        unknownName = true;
        return match;
      }
      return String(number);
    });
    if (unknownName) return false;
  }
  if (!spec.chars.test(value)) return false;
  return value.split(',').every((item) => isValidItem(item, spec));
}

function isInteger(text: string): boolean {
  return /^\d+$/.test(text);
}

function inRange(text: string, spec: FieldSpec): boolean {
  const number = Number(text);
  return number >= spec.min && number <= spec.max;
}

/** One list item: `*`, `?`, `n`, `a-b`, optionally followed by `/step`. */
function isValidItem(item: string, spec: FieldSpec): boolean {
  if (item.length === 0) return false;
  // Provider extensions (`L`, `#`, hashed `H`) are left to the provider.
  if (/[LH#]/.test(item)) return true;
  const parts = item.split('/');
  if (parts.length > 2) return false;
  const [range = '', step] = parts;
  if (step !== undefined && (!isInteger(step) || Number(step) < 1)) return false;
  if (range === '*' || range === '?') return true;
  const bounds = range.split('-');
  if (bounds.length > 2 || !bounds.every((bound) => isInteger(bound) && inRange(bound, spec))) {
    return false;
  }
  return bounds.length === 1 || Number(bounds[0]) <= Number(bounds[1]);
}
