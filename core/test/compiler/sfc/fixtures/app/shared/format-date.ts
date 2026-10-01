/** Formats an ISO date as day/month/year for the SFC fixture app. */

export function formatDate(date: string): string {
  return date.split('-').reverse().join('/');
}
