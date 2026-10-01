/**
 * Build the page object for one request: validate the component, resolve the
 * props, and assemble the v3 page.
 *
 * The component is checked before any resolver runs, so a bad name costs no
 * work. `url` is the request path and query, which is what the client pushes
 * onto its history; a trailing slash is kept as sent.
 */

import { assertComponent, createPageObject } from './page.js';
import type { InertiaPageObject } from './page.js';
import { resolveProps } from './resolve-props.js';
import type { ResolvePropsInput } from './resolve-props.js';

/** Input to {@link buildInertiaPage}. */
export interface BuildPageInput extends ResolvePropsInput {
  /** The asset version; `''` turns versioning off. */
  readonly version: string;
  /** One-shot data for the client's flash event; sent only when it has a key. */
  readonly flash?: Readonly<Record<string, unknown>>;
  readonly encryptHistory?: boolean;
  readonly clearHistory?: boolean;
  readonly preserveFragment?: boolean;
}

/** Resolve the props and assemble the page object for one request. */
export async function buildInertiaPage(input: BuildPageInput): Promise<InertiaPageObject> {
  assertComponent(input.component);
  const { props, metadata } = await resolveProps(input);
  return createPageObject({
    component: input.component,
    props,
    url: `${input.facts.url.pathname}${input.facts.url.search}`,
    version: input.version,
    metadata,
    ...(input.flash === undefined ? {} : { flash: input.flash }),
    ...(input.encryptHistory === undefined ? {} : { encryptHistory: input.encryptHistory }),
    ...(input.clearHistory === undefined ? {} : { clearHistory: input.clearHistory }),
    ...(input.preserveFragment === undefined ? {} : { preserveFragment: input.preserveFragment }),
  });
}
