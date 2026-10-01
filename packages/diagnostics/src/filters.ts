/**
 * Record-time and read-time filter gates for the diagnostics recorder.
 * Filters are pure predicate/transform functions — no I/O, no state.
 */

import type { DiagnosticsEntry, DiagnosticsFilters } from 'jsails/diagnostics';

/**
 * Record-time gate: apply a filter, returning `true` when the entry should be
 * kept. A throwing filter is treated as fail-closed (drop) so a broken filter
 * never leaks entries into the buffer.
 */
export function applyFilters(entry: DiagnosticsEntry, filters: DiagnosticsFilters): boolean {
  if (filters.filter === undefined) return true;
  try {
    return filters.filter(entry);
  } catch {
    // Fail-closed: a throwing filter drops the entry rather than leaking it.
    return false;
  }
}
