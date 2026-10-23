import SwaggerParser from '@apidevtools/swagger-parser';

import type { AppConfig, ServiceName } from './config.js';
import { proxyRoutes, type ProxyRoute } from './routes.js';

// Service owners supply their contracts; undocumented services are never inferred.
export const documentedServices = [
  'user',
  'post',
  'map',
  'notification',
] as const;
export const undocumentedServices = ['moderation'] as const;
// Notification currently owns a valid HTTP contract with health only, not public APIs.
const servicesWithoutPublicApis: readonly ServiceName[] = ['notification'];
// Match @fastify/http-proxy default methods; TRACE is not exposed.
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
type ObjectValue = Record<string, any>;
export type ApiDocument = ObjectValue;

function walk(value: any, visit: (object: ObjectValue) => void): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function pointer(document: ApiDocument, ref: string): any {
  if (!ref.startsWith('#/'))
    throw new Error(`Only local JSON references are supported: ${ref}`);
  let value: any = document;
  for (const part of ref.slice(2).split('/')) {
    value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (value === undefined) throw new Error(`Unresolved reference: ${ref}`);
  return value;
}

export async function validateDocument(document: ApiDocument): Promise<void> {
  if (!/^3\.0\.\d+$/.test(document.openapi ?? '')) {
    throw new Error(
      `Unsupported OpenAPI version ${document.openapi}; expected 3.0.x`,
    );
  }
  walk(document, (object) => {
    if (typeof object.$ref === 'string') pointer(document, object.$ref);
    if (Array.isArray(object.security)) {
      for (const requirement of object.security) {
        for (const name of Object.keys(requirement)) {
          if (!document.components?.securitySchemes?.[name]) {
            throw new Error(`Undefined security scheme: ${name}`);
          }
        }
      }
    }
  });
  // Validation dereferences its input, so always give it a disposable clone.
  await SwaggerParser.validate(
    structuredClone(document) as unknown as Exclude<
      Parameters<SwaggerParser['validate']>[0],
      string
    >,
    {
      resolve: { external: false },
    },
  );
}

function baseComponentRef(ref: string): string {
  return ref.startsWith('#/components/')
    ? ref.split('/').slice(0, 4).join('/')
    : ref;
}

function rewriteRef(ref: string, names: Map<string, string>): string {
  const base = baseComponentRef(ref);
  return (names.get(base) ?? base) + ref.slice(base.length);
}

function componentRef(category: string, name: string): string {
  return `#/components/${category}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function gatewayResponse(description: string, code: string): ObjectValue {
  return {
    description,
    headers: {
      'x-request-id': {
        schema: { type: 'string' },
        description: 'Gateway request ID',
      },
      ...(code === 'GATEWAY_RATE_LIMITED'
        ? {
            'Retry-After': {
              schema: { type: 'integer' },
              description: 'Seconds until retry',
            },
          }
        : {}),
    },
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['code', 'message', 'requestId', 'timestamp'],
          properties: {
            code: { type: 'string', enum: [code] },
            message: { type: 'string' },
            requestId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}

function addGatewayResponses(
  operation: ObjectValue,
  path: string,
  method: string,
  config: AppConfig,
): void {
  const additions: ObjectValue = {
    '400': gatewayResponse('Gateway malformed request.', 'GATEWAY_BAD_REQUEST'),
    '413': gatewayResponse(
      `Gateway body limit: ${config.bodyLimitBytes} bytes.`,
      'GATEWAY_PAYLOAD_TOO_LARGE',
    ),
    '502': gatewayResponse(
      'Gateway cannot reach upstream.',
      'GATEWAY_BAD_UPSTREAM',
    ),
    '504': gatewayResponse(
      `Gateway upstream timeout: ${config.upstream.requestTimeoutMs} ms.`,
      'GATEWAY_TIMEOUT',
    ),
  };
  if (config.rateLimit.enabled) {
    additions['429'] = gatewayResponse(
      `Gateway IP limit: ${config.rateLimit.max} requests / ${config.rateLimit.windowMs} ms.`,
      'GATEWAY_RATE_LIMITED',
    );
    if (path === '/api/v1/location' && method === 'put') {
      additions['429'].description +=
        ' Location PUT: 60 requests per rolling 60 seconds per IP.';
      additions['503'] = gatewayResponse(
        'Gateway cannot check the location IP rate limit.',
        'GATEWAY_UPSTREAM_UNAVAILABLE',
      );
    }
  }
  for (const [status, response] of Object.entries(additions)) {
    const original = operation.responses[status];
    // Upstream errors pass through unchanged, including empty Map responses.
    if (original) {
      original.description += ` Also possible at Gateway: ${response.description}`;
      original['x-gateway-response'] = response;
    } else operation.responses[status] = response;
  }
}

export async function mergeDocuments(
  sources: Array<{ service: ServiceName; document: ApiDocument }>,
  config: AppConfig,
  routes: readonly ProxyRoute[] = proxyRoutes,
): Promise<ApiDocument> {
  const result: ApiDocument = {
    openapi: '3.0.3',
    info: {
      title: 'WGO Public HTTP API',
      version: '1.0.0',
      description:
        'Local/dev Gateway API. Some services may have no public operations; see x-services-without-public-operations. User JWT authentication is not implemented in the Gateway. Use the documented local context headers (X-User-Id, and X-Session-Id for User logout). Internal service tokens are not public credentials. Gateway errors include code, message, requestId and timestamp; upstream responses pass through unchanged. Existing status codes may have an x-gateway-response describing the additional Gateway error shape.',
    },
    servers: [{ url: '/' }],
    paths: {},
    components: {},
    'x-undocumented-services': undocumentedServices,
    'x-services-without-public-operations': [],
  };
  const operationIds = new Set<string>();
  const serviceNames = new Set<string>();
  for (const source of sources) {
    if (serviceNames.has(source.service))
      throw new Error(`Duplicate service: ${source.service}`);
    serviceNames.add(source.service);
    try {
      await validateDocument(source.document);
    } catch (error) {
      throw new Error(
        `${source.service}: invalid OpenAPI: ${error instanceof Error ? error.message : error}`,
      );
    }
    const document = structuredClone(source.document);
    const refNames = new Map<string, string>();
    for (const [category, entries] of Object.entries(
      document.components ?? {},
    ) as Array<[string, ObjectValue]>) {
      for (const name of Object.keys(entries)) {
        refNames.set(
          componentRef(category, name),
          componentRef(category, `${source.service}__${name}`),
        );
      }
    }
    const ids = new Map<string, string>();
    const publicPaths: ObjectValue = {};
    for (const [path, item] of Object.entries(document.paths) as Array<
      [string, ObjectValue]
    >) {
      if (
        !routes.some(
          (route) =>
            route.service === source.service &&
            (path === route.prefix || path.startsWith(`${route.prefix}/`)),
        )
      )
        continue;
      if (/(?:^|\/)(?:internal|health|metrics|docs)(?:\/|$)/.test(path))
        continue;
      if (item.$ref)
        throw new Error(`Referenced path items are not supported: ${path}`);
      const selected: ObjectValue = {};
      for (const key of ['summary', 'description', 'parameters'])
        if (item[key] !== undefined) selected[key] = item[key];
      for (const method of methods) {
        if (!item[method]) continue;
        const operation = item[method];
        delete operation.servers;
        if (operation.callbacks)
          throw new Error(
            `Callbacks are outside public HTTP docs: ${path} ${method}`,
          );
        operation.security ??= document.security ?? [];
        if (operation.operationId) {
          const renamed = `${source.service}__${operation.operationId}`;
          if (operationIds.has(renamed))
            throw new Error(`Duplicate operationId: ${renamed}`);
          operationIds.add(renamed);
          ids.set(operation.operationId, renamed);
          operation.operationId = renamed;
        }
        addGatewayResponses(operation, path, method, config);
        selected[method] = operation;
      }
      if (methods.some((method) => selected[method]))
        publicPaths[path] = selected;
    }
    if (!Object.keys(publicPaths).length) {
      if (!servicesWithoutPublicApis.includes(source.service))
        throw new Error(
          `${source.service}: no Gateway public operations found`,
        );
      result['x-services-without-public-operations'].push(source.service);
      continue;
    }
    // Copy only components reachable from public operations, including security requirements.
    const used = new Set<string>();
    const components: ObjectValue = {};
    const discover = (value: any): void =>
      walk(value, (object) => {
        const refs: string[] = [];
        if (typeof object.$ref === 'string') refs.push(object.$ref);
        if (object.discriminator?.mapping)
          refs.push(
            ...(Object.values(object.discriminator.mapping) as string[]),
          );
        if (Array.isArray(object.security))
          for (const requirement of object.security) {
            for (const name of Object.keys(requirement))
              refs.push(componentRef('securitySchemes', name));
          }
        for (const ref of refs) {
          pointer(document, ref);
          const base = baseComponentRef(ref);
          if (!refNames.has(base) || used.has(base)) continue;
          used.add(base);
          const target = pointer(document, base);
          const [, , category, escapedName] = base.split('/');
          if (
            category === 'securitySchemes' &&
            ['service-jwt', 'GatewayBearer'].includes(escapedName!)
          ) {
            throw new Error(
              `${source.service}: public operation references internal authentication ${escapedName}`,
            );
          }
          const name = escapedName!.replace(/~1/g, '/').replace(/~0/g, '~');
          const renamed = `${source.service}__${name}`;
          (components[category!] ??= {})[renamed] = structuredClone(target);
          discover(components[category!][renamed]);
        }
      });
    discover(publicPaths);
    const fragment = { paths: publicPaths, components };
    walk(fragment, (object) => {
      if (typeof object.$ref === 'string')
        object.$ref = rewriteRef(object.$ref, refNames);
      if (object.discriminator?.mapping)
        for (const [name, ref] of Object.entries(
          object.discriminator.mapping,
        )) {
          object.discriminator.mapping[name] = rewriteRef(
            ref as string,
            refNames,
          );
        }
      if (Array.isArray(object.security))
        object.security = object.security.map((requirement: ObjectValue) =>
          Object.fromEntries(
            Object.entries(requirement).map(([name, scopes]) => [
              `${source.service}__${name}`,
              scopes,
            ]),
          ),
        );
      if (typeof object.operationId === 'string' && ids.has(object.operationId))
        object.operationId = ids.get(object.operationId);
    });
    for (const [path, item] of Object.entries(publicPaths) as Array<
      [string, ObjectValue]
    >) {
      const destination = (result.paths[path] ??= {});
      for (const method of methods)
        if (item[method]) {
          if (destination[method])
            throw new Error(
              `Duplicate public operation: ${method.toUpperCase()} ${path}`,
            );
          destination[method] = item[method];
        }
      for (const key of ['parameters', 'summary', 'description'])
        if (item[key] !== undefined) {
          if (
            destination[key] !== undefined &&
            JSON.stringify(destination[key]) !== JSON.stringify(item[key])
          ) {
            throw new Error(`Conflicting path ${key}: ${path}`);
          }
          destination[key] = item[key];
        }
    }
    for (const [category, entries] of Object.entries(components))
      Object.assign((result.components[category] ??= {}), entries);
  }
  walk(result.paths, (object) => {
    if (
      typeof object.operationId === 'string' &&
      !operationIds.has(object.operationId)
    ) {
      throw new Error(
        `Link references an undocumented operationId: ${object.operationId}`,
      );
    }
    if (typeof object.operationRef === 'string')
      pointer(result, object.operationRef);
    if (object.operationId || object.operationRef) delete object.server;
  });
  if (result['x-services-without-public-operations'].length)
    result.info.description += ` No public HTTP operations implemented: ${result['x-services-without-public-operations'].join(', ')}.`;
  await validateDocument(result);
  return result;
}
