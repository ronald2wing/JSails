/** Merge a caller class with a component class, dropping empty values. */
export function cx(...parts: unknown[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}
