/**
 * The `night` built-in theme: a dark, high-contrast child of `neutral` with a
 * bright cyan accent.
 */

/** The night discovery entry, included in the built-in theme set. */
export const nightTheme = {
  path: 'night',
  manifest: {
    name: 'night',
    version: '1.0.0',
    parent: 'neutral',
    description: 'Dark high-contrast theme with a bright cyan accent.',
    author: 'JSails',
    tokens: {
      '--jsails-bg': '#0f172a',
      '--jsails-fg': '#e2e8f0',
      '--jsails-accent': '#22d3ee',
      '--jsails-muted': '#1e293b',
      '--jsails-border': '#334155',
      '--jsails-radius': '0.375rem',
    },
    contentTypes: ['article', 'page'],
  },
} as const;
