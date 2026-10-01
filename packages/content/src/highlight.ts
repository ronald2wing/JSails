/**
 * Memoized Shiki syntax highlighter for the content layer.
 *
 * Built once per process and shared across every markdown fence block.
 * Uses Shiki's dual-theme support (CSS variables) so a future theme toggle
 * can flip light/dark without re-highlighting.
 *
 * Languages are loaded on demand: Shiki's bundled grammars by id, and the
 * languages this package registers itself (`jsails`, `.jsails` components) by
 * importing their grammar, after the bundled grammars it embeds, the first
 * time a fence names one. Each language loads once, also when fences
 * highlight in parallel. An unknown language renders as plain text.
 */

import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type LanguageRegistration,
} from 'shiki';

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * The languages this package registers, each a lazy import of its grammar, so
 * a site that never shows one loads nothing for it.
 */
const LOCAL_LANGUAGES: Readonly<Record<string, () => Promise<LanguageRegistration>>> =
  Object.freeze({
    jsails: async () => (await import('./jsails-grammar.js')).jsailsGrammar,
  });

let highlighter: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: [THEMES.light, THEMES.dark],
    langs: [], // start empty; loaded on demand
  });
  return highlighter;
}

function isBundled(lang: string): lang is BundledLanguage {
  return Object.hasOwn(bundledLanguages, lang);
}

/** Whether `lang` loaded, by language; a language's load starts once. */
const loads = new Map<string, Promise<boolean>>();

function ensureLanguage(instance: Highlighter, lang: string): Promise<boolean> {
  let load = loads.get(lang);
  if (load === undefined) {
    load = loadLanguage(instance, lang);
    loads.set(lang, load);
  }
  return load;
}

async function loadLanguage(instance: Highlighter, lang: string): Promise<boolean> {
  if (isBundled(lang)) {
    await instance.loadLanguage(lang);
    return true;
  }
  const local = Object.hasOwn(LOCAL_LANGUAGES, lang) ? LOCAL_LANGUAGES[lang] : undefined;
  if (local === undefined) return false;
  const grammar = await local();
  // Shiki resolves an embedded language only when it is already loaded.
  await instance.loadLanguage(...(grammar.embeddedLangs ?? []).filter(isBundled));
  await instance.loadLanguage(grammar);
  return true;
}

/** Highlight `code` as `lang` to HTML; an empty or unknown `lang` renders plain text. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const instance = await getHighlighter();
  const known = lang !== '' && (await ensureLanguage(instance, lang));
  return instance.codeToHtml(code, {
    lang: known ? lang : 'text',
    themes: THEMES,
    defaultColor: false,
  });
}
