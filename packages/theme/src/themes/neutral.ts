/**
 * The `neutral` built-in theme: a light palette with a muted gray accent.
 *
 * Plain data validated through discovery when `builtinThemePackages` loads;
 * `night` inherits from it.
 */

/** The neutral discovery entry, included in the built-in theme set. */
export const neutralTheme = {
  path: 'neutral',
  manifest: {
    name: 'neutral',
    version: '1.0.0',
    description: 'Neutral light theme with a muted gray accent.',
    author: 'JSails',
    tokens: {
      '--jsails-bg': '#ffffff',
      '--jsails-fg': '#1f2937',
      '--jsails-accent': '#6b7280',
      '--jsails-muted': '#f3f4f6',
      '--jsails-border': '#e5e7eb',
      '--jsails-radius': '0.375rem',
    },
    contentTypes: ['article', 'page'],
  },
} as const;
