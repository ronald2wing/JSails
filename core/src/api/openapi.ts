/**
 * Minimal OpenAPI 3 document generation from a map of declared resources.
 *
 * `generateOpenApi` takes a name-keyed map of resources — each declaring its
 * collection path, an optional tag, query parameters, and request/response JSON
 * schemas — and produces a deterministic OpenAPI 3.0 document with the five
 * resource operations per resource:
 *
 * - `GET {path}` (list), `POST {path}` (create),
 * - `GET {path}/{id}` (get), `PATCH {path}/{id}` (update),
 *   `DELETE {path}/{id}` (delete).
 *
 * The list operation describes what the resource handlers actually return: the
 * page envelope `{ count, results, page, pageSize, next, previous }` with
 * `results` holding the item schema, and the `page`/`pageSize` query
 * parameters every collection `GET` reads. A declared query parameter with the
 * same name replaces the generated one.
 *
 * Output is deterministic: resources are sorted by path (then name), paths are
 * emitted in sorted order, query parameters are sorted by name, tags are sorted,
 * and every operation builds its fields in a fixed order. No external OpenAPI
 * library is used — the document is a plain JSON-compatible object, so it
 * serializes with `JSON.stringify` with no dependency.
 */

import { compareStrings } from '../support/index.js';

/** A minimal JSON Schema subset sufficient to describe request/response shapes. */
export interface OpenApiJsonSchema {
  /** OpenAPI 3.0 has no `null` type; a nullable value sets `nullable: true`. */
  readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, OpenApiJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: OpenApiJsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly default?: unknown;
  /** OpenAPI 3.0's marker for a value that may also be `null`. */
  readonly nullable?: boolean;
}

/** A query parameter declaration for the list operation. */
export interface OpenApiQueryParam {
  readonly name: string;
  readonly required?: boolean;
  readonly schema: OpenApiJsonSchema;
  readonly description?: string;
}

/** A declared resource. */
export interface OpenApiResource {
  /** Collection path, e.g. `/users`. */
  readonly path: string;
  /** Tag grouping this resource's operations. Defaults to the resource name. */
  readonly tag?: string;
  /** Short description used for operation summaries. */
  readonly description?: string;
  /** Detail-route parameter name. Defaults to `"id"`. */
  readonly idParam?: string;
  /** Query parameters for the list operation. */
  readonly queryParams?: readonly OpenApiQueryParam[];
  /** Request body schema for create/update. */
  readonly requestSchema?: OpenApiJsonSchema;
  /** Response item schema. */
  readonly responseSchema?: OpenApiJsonSchema;
}

/** A path or query parameter. */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'query' | 'path';
  readonly required?: boolean;
  readonly schema: OpenApiJsonSchema;
  readonly description?: string;
}

/** A response entry. */
export interface OpenApiResponse {
  readonly description: string;
  readonly content?: {
    readonly 'application/json': { readonly schema: OpenApiJsonSchema };
  };
}

/** An operation (get/post/patch/delete) under a path. */
export interface OpenApiOperation {
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: true;
    readonly content: { readonly 'application/json': { readonly schema: OpenApiJsonSchema } };
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

/** The generated document. */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly tags?: readonly { readonly name: string }[];
}

/** Options for {@link generateOpenApi}. */
export interface GenerateOpenApiOptions {
  /** Document title. Defaults to `"API"`. */
  readonly title?: string;
  /** Document version. Defaults to `"0.1.0"`. */
  readonly version?: string;
  /** Resources keyed by name. */
  readonly resources: Readonly<Record<string, OpenApiResource>>;
}

/** Generate a minimal, deterministic OpenAPI 3 document. */
export function generateOpenApi(options: GenerateOpenApiOptions): OpenApiDocument {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('generateOpenApi requires an options object');
  }
  if (
    options.resources === null ||
    typeof options.resources !== 'object' ||
    Array.isArray(options.resources)
  ) {
    throw new TypeError('resources must be an object keyed by resource name');
  }

  const paths = new Map<string, Record<string, OpenApiOperation>>();
  const tags = new Set<string>();

  const resources = Object.entries(options.resources)
    .map(([name, resource]) => ({ name, resource }))
    .sort(
      (a, b) => compareStrings(a.resource.path, b.resource.path) || compareStrings(a.name, b.name),
    );

  for (const { name, resource } of resources) {
    const tag = resource.tag ?? name;
    tags.add(tag);
    assertResource(resource);

    const idParam = resource.idParam ?? 'id';
    const collectionPath = resource.path;
    const detailPath = `${stripTrailingSlash(collectionPath)}/{${idParam}}`;
    const pathParameter: OpenApiParameter = {
      name: idParam,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    };
    const declaredNames = new Set((resource.queryParams ?? []).map((param) => param.name));
    const queryParams = [
      ...PAGINATION_QUERY_PARAMS.filter((param) => !declaredNames.has(param.name)),
      ...(resource.queryParams ?? []),
    ]
      .sort((a, b) => compareStrings(a.name, b.name))
      .map((param): OpenApiParameter => ({
        name: param.name,
        in: 'query',
        required: param.required === true,
        schema: param.schema,
        ...(param.description !== undefined ? { description: param.description } : {}),
      }));

    const listOperation: OpenApiOperation = {
      tags: [tag],
      ...(resource.description !== undefined
        ? { summary: `List ${resource.description}` }
        : { summary: `List ${name}` }),
      parameters: queryParams,
      responses: {
        '200': jsonResponse('A page of resources', pageSchema(resource.responseSchema)),
      },
    };

    const createOperation: OpenApiOperation = {
      tags: [tag],
      ...(resource.description !== undefined
        ? { summary: `Create ${resource.description}` }
        : { summary: `Create ${name}` }),
      ...(resource.requestSchema !== undefined
        ? { requestBody: jsonRequestBody(resource.requestSchema) }
        : {}),
      responses: { '201': jsonResponse('Created', resource.responseSchema) },
    };

    const detailOperations: Record<string, OpenApiOperation> = {
      get: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Retrieve ${resource.description}` }
          : { summary: `Retrieve ${name}` }),
        parameters: [pathParameter],
        responses: { '200': jsonResponse('The resource', resource.responseSchema) },
      },
      patch: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Update ${resource.description}` }
          : { summary: `Update ${name}` }),
        parameters: [pathParameter],
        ...(resource.requestSchema !== undefined
          ? { requestBody: jsonRequestBody(resource.requestSchema) }
          : {}),
        responses: { '200': jsonResponse('The resource', resource.responseSchema) },
      },
      delete: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Delete ${resource.description}` }
          : { summary: `Delete ${name}` }),
        parameters: [pathParameter],
        responses: { '204': { description: 'No content' } },
      },
    };

    setOperation(paths, collectionPath, 'get', listOperation);
    setOperation(paths, collectionPath, 'post', createOperation);
    for (const [method, operation] of Object.entries(detailOperations)) {
      setOperation(paths, detailPath, method, operation);
    }
  }

  const sortedPaths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const path of [...paths.keys()].sort()) {
    const operations = paths.get(path);
    if (operations !== undefined) {
      sortedPaths[path] = operations;
    }
  }

  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: { title: options.title ?? 'API', version: options.version ?? '0.1.0' },
    paths: sortedPaths,
    tags: [...tags].sort().map((name) => ({ name })),
  };
  return document;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function assertResource(resource: OpenApiResource): void {
  if (typeof resource.path !== 'string' || !resource.path.startsWith('/')) {
    throw new TypeError('resource path must be a string starting with "/"');
  }
  if (
    resource.idParam !== undefined &&
    (typeof resource.idParam !== 'string' || resource.idParam.length === 0)
  ) {
    throw new TypeError('idParam must be a non-empty string');
  }
}

function jsonRequestBody(schema: OpenApiJsonSchema): {
  readonly required: true;
  readonly content: { readonly 'application/json': { readonly schema: OpenApiJsonSchema } };
} {
  return { required: true, content: { 'application/json': { schema } } };
}

/** The pagination parameters every collection `GET` reads. */
const PAGINATION_QUERY_PARAMS: readonly OpenApiQueryParam[] = [
  {
    name: 'page',
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1-based page number',
  },
  {
    name: 'pageSize',
    schema: { type: 'integer', minimum: 1 },
    description: 'Items per page, capped by the resource',
  },
];

/**
 * The page envelope the list handler returns. Without an item schema the
 * `results` items are `{}`, any value, because OpenAPI 3.0 requires `items` on
 * every array.
 */
function pageSchema(item: OpenApiJsonSchema | undefined): OpenApiJsonSchema {
  const pageNumber: OpenApiJsonSchema = { type: 'integer', minimum: 1, nullable: true };
  return {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0 },
      results: { type: 'array', items: item ?? {} },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1 },
      next: pageNumber,
      previous: pageNumber,
    },
    required: ['count', 'results', 'page', 'pageSize', 'next', 'previous'],
  };
}

function jsonResponse(description: string, schema?: OpenApiJsonSchema): OpenApiResponse {
  if (schema === undefined) {
    return { description };
  }
  return { description, content: { 'application/json': { schema } } };
}

function setOperation(
  paths: Map<string, Record<string, OpenApiOperation>>,
  path: string,
  method: string,
  operation: OpenApiOperation,
): void {
  const operations = paths.get(path) ?? {};
  operations[method] = operation;
  paths.set(path, operations);
}
