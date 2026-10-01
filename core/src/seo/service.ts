/**
 * SEO kernel contract (`jsails/seo`).
 *
 * The page renderer resolves this service from the application's service
 * registry, falling back to the stateless default below. An application or
 * plugin can replace head-tag emission without replacing route discovery,
 * metadata resolution, or static export.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { buildHeadTags, injectHead } from './head.js';
import type { PageMetadata, SeoRuntimeOptions } from './metadata.js';

/** The replaceable SEO rendering seam. */
export interface SeoService {
  /** Build the allowlisted head-tag string for one page. */
  buildHeadTags(metadata: PageMetadata, options?: SeoRuntimeOptions): string;
  /** Splice head tags into a rendered document. */
  injectHead(html: string, headTags: string): string;
}

/** Opaque token for the application {@link SeoService}. */
export const seoToken: ServiceToken<SeoService> = createServiceToken<SeoService>('seo');

/** The stateless default implementation backed by the core SEO helpers. */
export const defaultSeoService: SeoService = Object.freeze({
  buildHeadTags,
  injectHead,
});

/** True when a value satisfies the SEO rendering contract. */
export function isSeoService(value: unknown): value is SeoService {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SeoService>;
  return (
    typeof candidate.buildHeadTags === 'function' && typeof candidate.injectHead === 'function'
  );
}

/** Use a provided service when valid, else the stateless default. */
export function resolveSeoService(value: unknown): SeoService {
  return isSeoService(value) ? value : defaultSeoService;
}
