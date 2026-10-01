/**
 * The conformance ledger: every scenario of the pinned official suite this
 * package is expected to fail, each with the reason. It may only shrink. The
 * harness fails the run on a scenario that fails without an entry here (a
 * regression) and on an entry whose scenario now passes (a stale entry, to be
 * deleted), and `official-suite.test.ts` holds the ceiling no entry may be
 * added beyond.
 *
 * Every reason below is a deliberate exclusion, not a defect: a feature the
 * 2026-07-28 revision deprecates or removes, or one a stateless endpoint
 * cannot carry over the 2025 transport the suite speaks.
 */

/** The suite, pinned exactly; `npx --yes` fetches it, so it is no dependency of the repo. */
export const CONFORMANCE_SUITE = '@modelcontextprotocol/conformance@0.1.16';

/** One expected failure. */
export interface ExpectedFailure {
  /** `server`: the suite tests the fixture endpoint; `client`: it tests `connectMcp`. */
  readonly mode: 'server' | 'client';
  readonly scenario: string;
  readonly reason: string;
}

const LOGGING =
  'Logging is deprecated in 2026-07-28, and a server must not send notifications/message ' +
  'unless a request asks for them; the package does not advertise the logging capability.';
const SAMPLING = 'Sampling is deprecated in 2026-07-28; the package does not offer it.';
const STATELESS_ELICITATION =
  'Implemented with inputRequired, which 2026-07-28 clients answer by retrying and 2025 stdio ' +
  'clients answer through the legacy shim. The suite reaches the fixture over 2025 Streamable ' +
  'HTTP, where a stateless endpoint holds no channel for a server-to-client request, so the ' +
  'call fails with input_unavailable instead.';
const SUBSCRIPTIONS =
  'Resource subscriptions are not advertised: tool and resource sets are fixed per deploy.';
const SESSIONS =
  'Needs an Mcp-Session-Id; the endpoint is stateless (sessions are removed in 2026-07-28).';
const OAUTH_CLIENT =
  'The interactive OAuth client flow (discovery, registration, PKCE, token storage) is out of ' +
  'the 1.0 client: an app passes its own tokens through the headers provider.';

/** The expected failures: server scenarios, then client ones, each sorted by scenario. */
export const EXPECTED_FAILURES: readonly ExpectedFailure[] = Object.freeze(
  [
    { mode: 'server', scenario: 'elicitation-sep1034-defaults', reason: STATELESS_ELICITATION },
    { mode: 'server', scenario: 'elicitation-sep1330-enums', reason: STATELESS_ELICITATION },
    { mode: 'server', scenario: 'logging-set-level', reason: LOGGING },
    { mode: 'server', scenario: 'resources-subscribe', reason: SUBSCRIPTIONS },
    { mode: 'server', scenario: 'resources-unsubscribe', reason: SUBSCRIPTIONS },
    { mode: 'server', scenario: 'server-sse-multiple-streams', reason: SESSIONS },
    { mode: 'server', scenario: 'server-sse-polling', reason: SESSIONS },
    { mode: 'server', scenario: 'tools-call-elicitation', reason: STATELESS_ELICITATION },
    { mode: 'server', scenario: 'tools-call-sampling', reason: SAMPLING },
    { mode: 'server', scenario: 'tools-call-with-logging', reason: LOGGING },
    { mode: 'client', scenario: 'auth/2025-03-26-oauth-endpoint-fallback', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/2025-03-26-oauth-metadata-backcompat', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/basic-cimd', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/client-credentials-basic', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/client-credentials-jwt', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/cross-app-access-complete-flow', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/metadata-default', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/metadata-var1', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/metadata-var2', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/metadata-var3', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/offline-access-not-supported', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/offline-access-scope', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/pre-registration', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/scope-from-scopes-supported', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/scope-from-www-authenticate', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/scope-omitted-when-undefined', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/scope-retry-limit', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/scope-step-up', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/token-endpoint-auth-basic', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/token-endpoint-auth-none', reason: OAUTH_CLIENT },
    { mode: 'client', scenario: 'auth/token-endpoint-auth-post', reason: OAUTH_CLIENT },
  ].map((entry) => Object.freeze(entry as ExpectedFailure)),
);

/** The scenario names of the pinned suite (its `list` output), to catch a typo in an entry. */
export const SUITE_SCENARIOS: Readonly<Record<'server' | 'client', readonly string[]>> =
  Object.freeze({
    server: Object.freeze([
      'server-initialize',
      'logging-set-level',
      'ping',
      'completion-complete',
      'tools-list',
      'tools-call-simple-text',
      'tools-call-image',
      'tools-call-audio',
      'tools-call-embedded-resource',
      'tools-call-mixed-content',
      'tools-call-with-logging',
      'tools-call-error',
      'tools-call-with-progress',
      'tools-call-sampling',
      'tools-call-elicitation',
      'json-schema-2020-12',
      'elicitation-sep1034-defaults',
      'server-sse-polling',
      'server-sse-multiple-streams',
      'elicitation-sep1330-enums',
      'resources-list',
      'resources-read-text',
      'resources-read-binary',
      'resources-templates-read',
      'resources-subscribe',
      'resources-unsubscribe',
      'prompts-list',
      'prompts-get-simple',
      'prompts-get-with-args',
      'prompts-get-embedded-resource',
      'prompts-get-with-image',
      'dns-rebinding-protection',
    ]),
    client: Object.freeze([
      'initialize',
      'tools_call',
      'elicitation-sep1034-client-defaults',
      'sse-retry',
      'auth/metadata-default',
      'auth/metadata-var1',
      'auth/metadata-var2',
      'auth/metadata-var3',
      'auth/basic-cimd',
      'auth/scope-from-www-authenticate',
      'auth/scope-from-scopes-supported',
      'auth/scope-omitted-when-undefined',
      'auth/scope-step-up',
      'auth/scope-retry-limit',
      'auth/token-endpoint-auth-basic',
      'auth/token-endpoint-auth-post',
      'auth/token-endpoint-auth-none',
      'auth/pre-registration',
      'auth/2025-03-26-oauth-metadata-backcompat',
      'auth/2025-03-26-oauth-endpoint-fallback',
      'auth/resource-mismatch',
      'auth/offline-access-scope',
      'auth/offline-access-not-supported',
      'auth/client-credentials-jwt',
      'auth/client-credentials-basic',
      'auth/cross-app-access-complete-flow',
    ]),
  });
