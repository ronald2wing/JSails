/** Shared config sets for the `@jsails/config` tests. */

import { object, string } from 'jsails/api';

import { boolean, choice, defineConfig, integer, json, text } from '../src/index.js';

/** A site set exercising every field kind. */
export const siteConfig = defineConfig('site', {
  label: 'Site',
  fields: {
    title: text({ label: 'Site title', default: 'My site', required: true, max: 80 }),
    perPage: integer({ default: 10, min: 1, max: 100 }),
    comments: boolean({ default: true }),
    theme: choice({ options: ['light', 'dark'], default: 'light' }),
    links: json({ default: { home: '/' }, schema: object({ home: string() }) }),
  },
});

/** A second, smaller set. */
export const mailConfig = defineConfig('mail.sender', {
  fields: { from: text({ default: 'noreply@example.test' }) },
});
