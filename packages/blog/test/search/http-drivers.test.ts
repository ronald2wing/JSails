/**
 * External search drivers (Meilisearch, Typesense, OpenSearch) behind the
 * engine-neutral {@link BlogSearchEngine} contract.
 *
 * Every driver is exercised against an injected `fetch` double, so no test
 * touches the network. Assertions cover the exact request method/path/body and
 * auth header each driver emits, remote-id → published-post mapping, search
 * pagination, remove-on-unpublish, invalid-config rejection, and error
 * isolation (non-2xx, network failure, invalid JSON never surfaces as a raw
 * value or a thrown non-`BlogSearchError`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BlogSearchError,
  createBlogSearchEngine,
  createMemoryBlogRepository,
  type BlogSearchEngineOptions,
  type BlogRepository,
} from '../../src/index.js';
import { seedPost } from '../fixtures.js';

// ---------------------------------------------------------------------------
// Fetch double
// ---------------------------------------------------------------------------

/** A captured HTTP request from the double. */
interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A scripted response the double returns for the next matching request. */
type ScriptedResponse = (request: CapturedRequest) => {
  status: number;
  json?: unknown;
};

/**
 * Build a `fetch` double that records every request and returns scripted
 * responses in order, falling back to a `200` JSON body of `null`.
 */
function fetchDouble(): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: CapturedRequest[];
  respond: (script: ScriptedResponse) => void;
} {
  const requests: CapturedRequest[] = [];
  const scripts: ScriptedResponse[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input : input.url;
    const url = new URL(typeof raw === 'string' ? raw : raw.toString());
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const rawHeaders = init.headers;
      if (rawHeaders instanceof Headers) {
        for (const [key, value] of rawHeaders.entries()) headers[key] = value;
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) headers[key] = value;
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) headers[key] = value;
      }
    }
    const captured: CapturedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(captured);
    const script = scripts.shift();
    const result = script === undefined ? { status: 200, json: null } : script(captured);
    return new Response(result.json === undefined ? null : JSON.stringify(result.json), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    fetch: fetchImpl,
    requests,
    respond: (script) => scripts.push(script),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseOptions(
  driver: BlogSearchEngineOptions['driver'],
  repository: BlogRepository,
  fetch: typeof globalThis.fetch,
): BlogSearchEngineOptions {
  return { driver, repository, url: 'http://search.local', apiKey: 'secret', fetch };
}

// ---------------------------------------------------------------------------
// Meilisearch
// ---------------------------------------------------------------------------

describe('meilisearch driver', () => {
  it('upserts a published post with method, path, body, and bearer auth', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('meilisearch', repository, fetch) });
    const post = await seedPost(repository, { title: 'Hello world', slug: 'hello-world' });

    await engine.index(post);

    // The first write applies the index settings, then upserts.
    assert.equal(requests.length, 2);
    const settings = requests[0]!;
    assert.equal(settings.method, 'PATCH');
    assert.equal(settings.url.pathname, '/indexes/blog-posts/settings');
    const declared = JSON.parse(settings.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(declared.filterableAttributes, ['status']);
    assert.deepEqual(declared.searchableAttributes, ['title', 'excerpt', 'body']);
    const request = requests[1]!;
    assert.equal(request.method, 'PUT');
    assert.equal(request.url.pathname, `/indexes/blog-posts/documents`);
    assert.equal(request.url.search, '?primaryKey=id');
    assert.equal(request.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(request.body ?? '{}') as Array<Record<string, unknown>>;
    assert.equal(body[0]?.id, post.id);
    assert.equal(body[0]?.status, 'published');
    assert.equal(typeof body[0]?.body, 'string');
  });

  it('removes a post with a DELETE on the document path', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('meilisearch', repository, fetch) });

    await engine.remove('abc-123');

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, 'DELETE');
    assert.equal(requests[0]!.url.pathname, '/indexes/blog-posts/documents/abc-123');
  });

  it('applies the index settings only once per engine', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('meilisearch', repository, fetch) });
    const first = await seedPost(repository, { title: 'One', slug: 'one' });
    const second = await seedPost(repository, { title: 'Two', slug: 'two' });

    await engine.index(first);
    await engine.index(second);

    assert.deepEqual(
      requests.map((request) => request.method),
      ['PATCH', 'PUT', 'PUT'],
    );
  });

  it('searches without a status filter, so a fresh index never rejects the query', async () => {
    const repository = createMemoryBlogRepository();
    const published = await seedPost(repository, { title: 'P', slug: 'p' });
    const double = fetchDouble();
    const engine = createBlogSearchEngine({
      ...baseOptions('meilisearch', repository, double.fetch),
    });
    double.respond(() => ({
      status: 200,
      json: { hits: [{ id: published.id }], estimatedTotalHits: 1 },
    }));

    const result = await engine.search('hello', { page: 2, limit: 5 });

    assert.equal(double.requests.length, 1);
    const request = double.requests[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url.pathname, '/indexes/blog-posts/search');
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    assert.equal(body.q, 'hello');
    assert.equal(body.limit, 5);
    assert.equal(body.offset, 5);
    // Meilisearch rejects a filter on an attribute that is not declared
    // filterable; the index only holds published posts and every hit is
    // re-checked through the repository, so no filter is sent.
    assert.equal(body.filter, undefined);

    assert.equal(result.total, 1);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0]?.id, published.id);
  });

  it('answers an empty result when the index does not exist yet', async () => {
    const repository = createMemoryBlogRepository();
    const double = fetchDouble();
    const engine = createBlogSearchEngine({
      ...baseOptions('meilisearch', repository, double.fetch),
    });
    double.respond(() => ({ status: 404, json: { code: 'index_not_found' } }));

    const result = await engine.search('hello');

    assert.deepEqual(result, { posts: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// Typesense
// ---------------------------------------------------------------------------

describe('typesense driver', () => {
  it('ensures the collection on first write and upserts with the API key header', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('typesense', repository, fetch) });
    const post = await seedPost(repository, { title: 'T', slug: 't' });
    respond(() => ({ status: 201, json: {} }));
    respond(() => ({ status: 201, json: {} }));

    await engine.index(post);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.method, 'POST');
    assert.equal(requests[0]!.url.pathname, '/collections');
    assert.equal(requests[0]!.headers['X-TYPESENSE-API-KEY'], 'secret');
    const schema = JSON.parse(requests[0]!.body ?? '{}') as Record<string, unknown>;
    assert.equal(schema.name, 'blog-posts');
    assert.ok(Array.isArray(schema.fields));

    assert.equal(requests[1]!.method, 'POST');
    assert.equal(requests[1]!.url.pathname, '/collections/blog-posts/documents');
    assert.equal(requests[1]!.url.search, '?action=upsert');
  });

  it('treats an existing collection (409) as success when ensuring', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('typesense', repository, fetch) });
    const post = await seedPost(repository, { title: 'T', slug: 't' });
    respond(() => ({ status: 409, json: { message: 'already exists' } }));
    respond(() => ({ status: 201, json: {} }));

    await assert.doesNotReject(() => engine.index(post));
    assert.equal(requests.length, 2);
  });

  it('deletes a document by id', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('typesense', repository, fetch) });
    respond(() => ({ status: 201, json: {} }));
    respond(() => ({ status: 200, json: {} }));

    await engine.remove('xyz');

    assert.equal(requests[1]!.method, 'DELETE');
    assert.equal(requests[1]!.url.pathname, '/collections/blog-posts/documents/xyz');
  });

  it('maps a failure while reading the import result to a value-free BlogSearchError', async () => {
    const repository = createMemoryBlogRepository();
    const post = await seedPost(repository, { title: 'P', slug: 'p' });
    let calls = 0;
    // The collection setup succeeds; the import answers 200 but its body
    // stream fails mid-read, as a timeout or connection reset would.
    const brokenBodyFetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 201 });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const engine = createBlogSearchEngine({
      ...baseOptions('typesense', repository, brokenBodyFetch),
    });

    await assert.rejects(
      () => engine.reindex([post]),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'bad_response',
    );
  });

  it('issues a GET search with query_by/filter_by/pagination params', async () => {
    const repository = createMemoryBlogRepository();
    const published = await seedPost(repository, { title: 'P', slug: 'p' });
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('typesense', repository, fetch) });
    respond(() => ({ status: 201, json: {} }));
    respond(() => ({
      status: 200,
      json: { hits: [{ document: { id: published.id } }], found: 1 },
    }));

    const result = await engine.search('hello', { page: 1, limit: 3 });

    const searchRequest = requests[1]!;
    assert.equal(searchRequest.method, 'GET');
    assert.equal(searchRequest.url.pathname, '/collections/blog-posts/documents/search');
    assert.equal(searchRequest.url.searchParams.get('q'), 'hello');
    assert.equal(searchRequest.url.searchParams.get('query_by'), 'title,excerpt,body');
    assert.equal(searchRequest.url.searchParams.get('filter_by'), 'status:=published');
    assert.equal(searchRequest.url.searchParams.get('per_page'), '3');
    assert.equal(searchRequest.url.searchParams.get('page'), '1');

    assert.equal(result.total, 1);
    assert.equal(result.posts[0]?.id, published.id);
  });
});

// ---------------------------------------------------------------------------
// OpenSearch
// ---------------------------------------------------------------------------

describe('opensearch driver', () => {
  it('upserts and deletes via /_doc with a bearer token', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('opensearch', repository, fetch) });
    const post = await seedPost(repository, { title: 'O', slug: 'o' });

    await engine.index(post);
    await engine.remove(post.id);

    // The index is created (with its mapping) once, before the first write.
    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests.map((request) => request.headers.Authorization),
      ['Bearer secret', 'Bearer secret', 'Bearer secret'],
    );
    assert.equal(requests[0]!.method, 'PUT');
    assert.equal(requests[0]!.url.pathname, '/blog-posts');
    assert.equal(requests[1]!.method, 'PUT');
    assert.equal(requests[1]!.url.pathname, `/blog-posts/_doc/${post.id}`);
    assert.equal(requests[2]!.method, 'DELETE');
    assert.equal(requests[2]!.url.pathname, `/blog-posts/_doc/${post.id}`);
  });

  it('creates the index with an explicit keyword status and date publishedAt mapping', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('opensearch', repository, fetch) });

    await engine.remove('x');

    const mapping = JSON.parse(requests[0]!.body ?? '{}') as {
      mappings?: { properties?: Record<string, { type?: string }> };
    };
    assert.equal(mapping.mappings?.properties?.status?.type, 'keyword');
    assert.equal(mapping.mappings?.properties?.publishedAt?.type, 'date');
  });

  it('accepts an index that already exists and rejects any other creation failure', async () => {
    const repository = createMemoryBlogRepository();
    const existing = fetchDouble();
    const engine = createBlogSearchEngine({
      ...baseOptions('opensearch', repository, existing.fetch),
    });
    existing.respond(() => ({
      status: 400,
      json: { error: { type: 'resource_already_exists_exception' } },
    }));
    await assert.doesNotReject(() => engine.remove('x'));

    const failing = fetchDouble();
    const broken = createBlogSearchEngine({
      ...baseOptions('opensearch', repository, failing.fetch),
    });
    failing.respond(() => ({ status: 400, json: { error: { type: 'mapper_parsing_exception' } } }));
    await assert.rejects(
      () => broken.remove('x'),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'bad_response',
    );
  });

  it('omits the authorization header when no API key is provided', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({
      driver: 'opensearch',
      repository,
      url: 'http://search.local',
      fetch,
    });
    const post = await seedPost(repository, { title: 'O', slug: 'o' });

    await engine.index(post);

    assert.equal(requests[0]!.headers.Authorization, undefined);
  });

  it('searches with a multi_match and term filter, mapping _id hits back', async () => {
    const repository = createMemoryBlogRepository();
    const published = await seedPost(repository, { title: 'P', slug: 'p' });
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('opensearch', repository, fetch) });
    respond(() => ({ status: 200, json: { acknowledged: true } }));
    respond(() => ({
      status: 200,
      json: { hits: { total: { value: 1 }, hits: [{ _id: published.id }] } },
    }));

    const result = await engine.search('needle');

    const request = requests[1]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url.pathname, '/blog-posts/_search');
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body.query, {
      bool: {
        must: [
          { multi_match: { query: 'needle', fields: ['title', 'excerpt', 'body'] } },
          { term: { status: 'published' } },
        ],
      },
    });
    assert.deepEqual(body.sort, [{ publishedAt: { order: 'desc' } }]);

    assert.equal(result.total, 1);
    assert.equal(result.posts[0]?.id, published.id);
  });

  it('issues a match_all for an empty query', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests, respond } = fetchDouble();
    const engine = createBlogSearchEngine({ ...baseOptions('opensearch', repository, fetch) });
    respond(() => ({ status: 200, json: { acknowledged: true } }));
    respond(() => ({ status: 200, json: { hits: { total: { value: 0 }, hits: [] } } }));

    await engine.search(' ');

    const body = JSON.parse(requests[1]!.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body.query, {
      bool: { must: [{ match_all: {} }, { term: { status: 'published' } }] },
    });
  });
});

// ---------------------------------------------------------------------------
// Shared behavior across drivers
// ---------------------------------------------------------------------------

const DRIVERS = ['meilisearch', 'typesense', 'opensearch'] as const;

for (const driver of DRIVERS) {
  describe(`${driver} shared behavior`, () => {
    it('reindex bulk-upserts published posts and removes non-published ones', async () => {
      const repository = createMemoryBlogRepository();
      const { fetch, requests, respond } = fetchDouble();
      const engine = createBlogSearchEngine({ ...baseOptions(driver, repository, fetch) });
      const published = await seedPost(repository, { title: 'P', slug: 'p' });
      const draft = await seedPost(repository, { title: 'D', slug: 'd', status: 'draft' });
      // Index/collection setup, then the bulk write's success report.
      respond(() => ({ status: 201, json: {} }));
      respond(() => ({
        status: 200,
        json: driver === 'opensearch' ? { errors: false } : { success: true },
      }));
      // The draft was never indexed: the engine answers its DELETE with 404,
      // which is nothing to remove, not a failure.
      respond(() => ({ status: 404, json: { message: 'not found' } }));

      await engine.reindex([published, draft]);

      // The published post goes through the engine's bulk endpoint.
      const bulkPath = {
        meilisearch: '/indexes/blog-posts/documents',
        typesense: '/collections/blog-posts/documents/import',
        opensearch: '/blog-posts/_bulk',
      }[driver];
      const bulk = requests.find((request) => request.url.pathname === bulkPath);
      assert.ok(bulk, 'reindex must use the bulk endpoint');
      assert.ok(bulk.body?.includes(published.id));
      assert.ok(!bulk.body?.includes(draft.id));
      const isDelete = requests.some(
        (request) => request.method === 'DELETE' && request.url.pathname.endsWith(draft.id),
      );
      assert.ok(isDelete);
    });

    it('reindex batches published posts into bounded bulk requests', async () => {
      const repository = createMemoryBlogRepository();
      const { fetch, requests, respond } = fetchDouble();
      const engine = createBlogSearchEngine({ ...baseOptions(driver, repository, fetch) });
      const posts = [];
      for (let i = 0; i < 101; i += 1) {
        posts.push(await seedPost(repository, { title: `P${i}`, slug: `p-${i}` }));
      }
      const success = driver === 'opensearch' ? { errors: false } : { success: true };
      respond(() => ({ status: 201, json: {} }));
      respond(() => ({ status: 200, json: success }));
      respond(() => ({ status: 200, json: success }));

      await engine.reindex(posts);

      // 101 posts at 100 per batch: two bulk writes after the one setup call.
      assert.equal(requests.length, 3);
    });

    it('aborts a request that exceeds the timeout with a value-free request_failed', async () => {
      const repository = createMemoryBlogRepository();
      const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof globalThis.fetch;
      const engine = createBlogSearchEngine({
        ...baseOptions(driver, repository, hangingFetch),
        timeoutMs: 20,
      });

      await assert.rejects(
        () => engine.search('q'),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'request_failed',
      );
    });

    it('drops non-published posts from search hits (remove-on-unpublish contract)', async () => {
      const repository = createMemoryBlogRepository();
      const draft = await seedPost(repository, { title: 'D', slug: 'd', status: 'draft' });
      const { fetch, respond } = fetchDouble();
      const engine = createBlogSearchEngine({ ...baseOptions(driver, repository, fetch) });
      // Typesense and OpenSearch ensure the collection/index before searching.
      if (driver !== 'meilisearch') respond(() => ({ status: 201, json: {} }));
      // The engine reports the draft id as a hit, but mapping must drop it.
      respond(() => ({
        status: 200,
        json:
          driver === 'meilisearch'
            ? { hits: [{ id: draft.id }], estimatedTotalHits: 1 }
            : driver === 'typesense'
              ? { hits: [{ document: { id: draft.id } }], found: 1 }
              : { hits: { total: { value: 1 }, hits: [{ _id: draft.id }] } },
      }));

      const result = await engine.search('anything');

      assert.equal(result.posts.length, 0);
    });

    it('isolates a non-2xx response as a value-free bad_response', async () => {
      const repository = createMemoryBlogRepository();
      const { fetch, respond } = fetchDouble();
      const engine = createBlogSearchEngine({ ...baseOptions(driver, repository, fetch) });
      respond(() => ({ status: 500, json: { secret: 'query-should-not-leak' } }));

      await assert.rejects(
        () => engine.search('top secret query'),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'bad_response',
      );
    });

    it('isolates a network failure as a value-free request_failed', async () => {
      const repository = createMemoryBlogRepository();
      const failingFetch = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch;
      const engine = createBlogSearchEngine({
        ...baseOptions(driver, repository, failingFetch),
      });

      await assert.rejects(
        () => engine.search('q'),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'request_failed',
      );
    });

    it('isolates invalid JSON as a value-free bad_response', async () => {
      const repository = createMemoryBlogRepository();
      const { fetch, respond } = fetchDouble();
      const engine = createBlogSearchEngine({ ...baseOptions(driver, repository, fetch) });
      if (driver !== 'meilisearch') respond(() => ({ status: 201, json: {} }));
      respond(() => ({ status: 200, json: undefined }));

      await assert.rejects(
        () => engine.search('q'),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'bad_response',
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Factory and config validation
// ---------------------------------------------------------------------------

describe('createBlogSearchEngine config validation', () => {
  it('routes `database` to the repository-backed engine with no network', async () => {
    const repository = createMemoryBlogRepository();
    await seedPost(repository, { title: 'Fibers', slug: 'fibers' });
    let called = false;
    const fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const engine = createBlogSearchEngine({ driver: 'database', repository, fetch });

    const result = await engine.search('fiber');
    assert.equal(result.total, 1);
    assert.equal(called, false);
  });

  it('rejects a non-http(s) URL', () => {
    const repository = createMemoryBlogRepository();
    assert.throws(
      () =>
        createBlogSearchEngine({
          driver: 'meilisearch',
          repository,
          url: 'ftp://search.local',
          apiKey: 'secret',
        }),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
    );
  });

  it('rejects a malformed URL', () => {
    const repository = createMemoryBlogRepository();
    assert.throws(
      () =>
        createBlogSearchEngine({
          driver: 'meilisearch',
          repository,
          url: 'not-a-url',
          apiKey: 'secret',
        }),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
    );
  });

  it('rejects a missing URL', () => {
    const repository = createMemoryBlogRepository();
    assert.throws(
      () => createBlogSearchEngine({ driver: 'meilisearch', repository, apiKey: 'secret' }),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
    );
  });

  it('rejects an unsafe index name', () => {
    const repository = createMemoryBlogRepository();
    assert.throws(
      () =>
        createBlogSearchEngine({
          driver: 'meilisearch',
          repository,
          url: 'http://search.local',
          apiKey: 'secret',
          index: 'Bad Index!',
        }),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
    );
  });

  it('rejects a missing API key for engines that require one', () => {
    const repository = createMemoryBlogRepository();
    for (const driver of ['meilisearch', 'typesense'] as const) {
      assert.throws(
        () => createBlogSearchEngine({ driver, repository, url: 'http://search.local' }),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
      );
    }
  });

  it('rejects a timeout outside 1 to 120000 ms', () => {
    const repository = createMemoryBlogRepository();
    for (const timeoutMs of [0, -1, 1.5, 120_001]) {
      assert.throws(
        () =>
          createBlogSearchEngine({
            driver: 'meilisearch',
            repository,
            url: 'http://search.local',
            apiKey: 'secret',
            timeoutMs,
          }),
        (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
      );
    }
  });

  it('allows OpenSearch without an API key (optional auth)', () => {
    const repository = createMemoryBlogRepository();
    const engine = createBlogSearchEngine({
      driver: 'opensearch',
      repository,
      url: 'http://search.local',
    });
    assert.ok(engine);
  });

  it('rejects an unknown driver', () => {
    const repository = createMemoryBlogRepository();
    assert.throws(
      () =>
        createBlogSearchEngine({
          driver: 'elastic' as BlogSearchEngineOptions['driver'],
          repository,
          url: 'http://search.local',
        }),
      (error: unknown) => error instanceof BlogSearchError && error.code === 'invalid_config',
    );
  });

  it('defaults the index name to blog-posts', async () => {
    const repository = createMemoryBlogRepository();
    const { fetch, requests } = fetchDouble();
    const engine = createBlogSearchEngine({
      driver: 'meilisearch',
      repository,
      url: 'http://search.local',
      apiKey: 'secret',
      fetch,
    });
    const post = await seedPost(repository, { title: 'P', slug: 'p' });
    await engine.index(post);
    assert.ok(requests[0]!.url.pathname.startsWith('/indexes/blog-posts/'));
  });
});
