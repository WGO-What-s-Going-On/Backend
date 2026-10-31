import { frontendAuth, frontendBearer } from './frontend-auth-fixture.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { generateDocs } from '../src/docs-generate.js';
import {
  documentedServices,
  mergeDocuments,
  validateDocument,
  type ApiDocument,
} from '../src/openapi.js';

const cleanup: Array<() => Promise<unknown>> = [];
const originalEnv = { ...process.env };
const tempRoot = tmpdir();
afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
function config(): AppConfig {
  process.env = {
    NODE_ENV: 'test',
    DOCS_ENABLED: 'true',
    RATE_LIMIT_ENABLED: 'false',
    LOG_PRETTY: 'false',
  };
  return { ...loadConfig(), userAuth: frontendAuth };
}
function fixture(path = '/api/v1/posts'): ApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1' },
    servers: [{ url: 'http://service:3002' }],
    security: [{ Identity: [] }],
    paths: {
      [path]: {
        servers: [{ url: 'http://service:3002' }],
        get: {
          operationId: 'read',
          servers: [{ url: 'http://service:3002' }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Result' },
                },
              },
            },
          },
        },
      },
      '/internal/test': {
        get: {
          security: [{ Internal: [] }],
          responses: { '200': { description: 'Internal' } },
        },
      },
      '/health/live': {
        get: { responses: { '200': { description: 'Live' } } },
      },
      '/api/v1/posts-other': {
        get: { responses: { '200': { description: 'Not matched' } } },
      },
    },
    components: {
      schemas: {
        Result: {
          type: 'object',
          properties: { child: { $ref: '#/components/schemas/Result' } },
        },
        InternalOnly: { type: 'string' },
      },
      securitySchemes: {
        Identity: { type: 'apiKey', in: 'header', name: 'X-Test' },
        Internal: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}
async function directory() {
  const dir = await mkdtemp(join(tempRoot, 'wgo-docs-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Keep the service-owned body/response schemas while replacing only internal auth.
function blocksAndReports(service: 'user' | 'moderation'): ApiDocument {
  const doc = fixture('/api/v1/users/me');
  const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (name: string) => ({
    'application/json': { schema: schema(name) },
  });
  const internalHeaders = ['X-User-Id', 'X-Session-Id', 'Authorization'].map(
    (name) => ({
      in: 'header',
      name,
      schema: { type: 'string' },
    }),
  );
  const operation = (status: string, request?: string, response?: string) => ({
    parameters: internalHeaders,
    ...(request
      ? { requestBody: { required: true, content: json(request) } }
      : {}),
    responses: {
      [status]: {
        description: 'Success',
        ...(response ? { content: json(response) } : {}),
      },
    },
  });
  const pathParameter = (name: string) => ({
    in: 'path',
    name,
    required: true,
    schema: { type: 'string' },
  });
  if (service === 'user') {
    Object.assign(doc.components.schemas, {
      CreateBlock: {
        type: 'object',
        required: ['blockedUserId'],
        properties: { blockedUserId: { type: 'string' } },
      },
      LegacyBlock: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'string' } },
      },
      BlockPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: schema('Block') },
          nextCursor: { type: 'string', nullable: true },
        },
      },
      Block: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          nickname: { type: 'string' },
          profileImageKey: { type: 'string', nullable: true },
          blockedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time', deprecated: true },
        },
      },
    });
    doc.paths['/api/v1/users/me/blocks'] = {
      post: operation('204', 'CreateBlock'),
      get: operation('200', undefined, 'BlockPage'),
      put: operation('204', 'LegacyBlock'),
      delete: operation('204', 'LegacyBlock'),
    };
    doc.paths['/api/v1/users/me/blocks/{blockedUserId}'] = {
      parameters: [pathParameter('blockedUserId'), ...internalHeaders],
      delete: operation('204'),
    };
  } else {
    doc.paths = {
      '/api/v1/moderation/reports': {
        post: operation('201', 'CreateReport', 'Report'),
      },
      '/api/v1/moderation/reports/{reportId}': {
        parameters: [pathParameter('reportId'), ...internalHeaders],
        delete: operation('200', undefined, 'Report'),
      },
    };
    Object.assign(doc.components.schemas, {
      CreateReport: {
        type: 'object',
        required: ['targetType', 'postId', 'reason'],
        properties: {
          targetType: { type: 'string', enum: ['POST', 'COMMENT'] },
          postId: { type: 'string' },
          commentId: { type: 'string' },
          reason: {
            type: 'string',
            enum: [
              'SPAM',
              'HARASSMENT',
              'INAPPROPRIATE_CONTENT',
              'FALSE_INFORMATION',
              'OTHER',
            ],
          },
          description: { type: 'string', maxLength: 2000 },
        },
      },
      Report: {
        type: 'object',
        properties: {
          reportId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PENDING', 'WITHDRAWN', 'REVIEWED'],
          },
          createdAt: { type: 'string', format: 'date-time' },
          withdrawnAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    });
  }
  return doc;
}

function expectBlocksAndReports(doc: ApiDocument) {
  for (const [path, methods, service] of [
    ['/api/v1/users/me/blocks', ['get', 'post', 'put', 'delete'], 'user'],
    ['/api/v1/users/me/blocks/{blockedUserId}', ['delete'], 'user'],
    ['/api/v1/moderation/reports', ['post'], 'moderation'],
    ['/api/v1/moderation/reports/{reportId}', ['delete'], 'moderation'],
  ] as const) {
    const item = doc.paths[path];
    expect(item).toBeDefined();
    for (const method of methods) {
      expect(item[method]).toBeDefined();
      expect(item[method].security).toEqual([
        { [`${service}__UserAccess`]: [] },
      ]);
      expect(item[method].parameters).toEqual([]);
      expect(item[method].responses['401']).toBeDefined();
    }
    expect(
      item.parameters?.filter((p: { in: string }) => p.in === 'header') ?? [],
    ).toEqual([]);
  }
  expect(
    doc.paths['/api/v1/users/me/blocks'].post.responses['204'],
  ).toBeDefined();
  expect(
    doc.paths['/api/v1/moderation/reports'].post.responses['201'],
  ).toBeDefined();
  expect(
    doc.paths['/api/v1/moderation/reports/{reportId}'].delete.responses['200'],
  ).toBeDefined();
  expect(
    doc.paths['/api/v1/users/me/blocks'].post.requestBody.content[
      'application/json'
    ].schema.$ref,
  ).toBe('#/components/schemas/user__CreateBlock');
  expect(
    doc.components.schemas.moderation__CreateReport.properties.reason.enum,
  ).toContain('FALSE_INFORMATION');
  expect(
    doc.components.schemas.moderation__Report.properties.status.enum,
  ).toEqual(['PENDING', 'WITHDRAWN', 'REVIEWED']);
}

describe('public OpenAPI merge', () => {
  it('includes canonical and compatible blocks plus report creation/withdrawal with public auth', async () => {
    const doc = await mergeDocuments(
      [
        { service: 'user', document: blocksAndReports('user') },
        { service: 'moderation', document: blocksAndReports('moderation') },
      ],
      config(),
    );
    expectBlocksAndReports(doc);
    await validateDocument(doc);
    expect(Object.keys(doc.components.securitySchemes)).toEqual([
      'user__UserAccess',
      'moderation__UserAccess',
    ]);
  });
  it('replaces internal User credentials with public bearer authentication', async () => {
    const user = fixture('/api/v1/users/me');
    user.components.securitySchemes['service-jwt'] = {
      type: 'http',
      scheme: 'bearer',
    };
    user.security = [{ 'service-jwt': [] }];
    user.paths['/api/v1/users/me'].parameters = [
      { in: 'header', name: 'X-User-Id', schema: { type: 'string' } },
    ];
    user.paths['/api/v1/users/me'].get.parameters = [
      { in: 'header', name: 'X-Session-Id', schema: { type: 'string' } },
    ];
    const doc = await mergeDocuments(
      [{ service: 'user', document: user }],
      config(),
    );
    expect(doc.paths['/api/v1/users/me'].parameters).toEqual([]);
    expect(doc.paths['/api/v1/users/me'].get.parameters).toEqual([]);
    expect(doc.paths['/api/v1/users/me'].get.security).toEqual([
      { user__UserAccess: [] },
    ]);
    expect(doc.components.securitySchemes).toEqual({
      user__UserAccess: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT (HS256)',
      },
    });
  });
  it('namespaces component, operationId, recursive ref and inherited security collisions without mutating input', async () => {
    const post = fixture(),
      map = fixture('/api/v1/location');
    post.paths['/api/v1/posts'].trace = {
      responses: { '200': { description: 'Not proxied' } },
    };
    const before = JSON.stringify([post, map]);
    const doc = await mergeDocuments(
      [
        { service: 'post', document: post },
        { service: 'map', document: map },
      ],
      config(),
    );
    expect(Object.keys(doc.paths)).toEqual([
      '/api/v1/posts',
      '/api/v1/location',
    ]);
    expect(doc.servers).toEqual([{ url: '/' }]);
    expect(doc.paths['/api/v1/posts'].trace).toBeUndefined();
    expect(doc.paths['/api/v1/posts'].servers).toBeUndefined();
    expect(doc.paths['/api/v1/posts'].get.servers).toBeUndefined();
    expect(doc.paths['/api/v1/posts'].get.operationId).toBe('post__read');
    expect(doc.paths['/api/v1/location'].get.operationId).toBe('map__read');
    expect(doc.paths['/api/v1/posts'].get.security).toEqual([
      { post__UserAccess: [] },
    ]);
    expect(doc.components.schemas.post__Result.properties.child.$ref).toBe(
      '#/components/schemas/post__Result',
    );
    expect(Object.keys(doc.components.securitySchemes)).toEqual([
      'post__UserAccess',
      'map__UserAccess',
    ]);
    expect(doc.components.schemas.post__InternalOnly).toBeUndefined();
    expect(JSON.stringify([post, map])).toBe(before);
  });
  it('rewrites discriminator and link references, respecting security overrides', async () => {
    const doc = fixture();
    doc.paths['/api/v1/posts'].get.security = [];
    doc.components.schemas.Result = {
      type: 'object',
      discriminator: {
        propertyName: 'kind',
        mapping: { item: '#/components/schemas/Item' },
      },
    };
    doc.components.schemas.Item = { type: 'object' };
    doc.paths['/api/v1/posts'].get.responses['200'].links = {
      self: { operationId: 'read' },
    };
    const merged = await mergeDocuments(
      [{ service: 'post', document: doc }],
      config(),
    );
    expect(merged.paths['/api/v1/posts'].get.security).toEqual([
      { post__UserAccess: [] },
    ]);
    expect(merged.components.securitySchemes.post__UserAccess).toBeDefined();
    expect(
      merged.components.schemas.post__Result.discriminator.mapping.item,
    ).toBe('#/components/schemas/post__Item');
    expect(
      merged.paths['/api/v1/posts'].get.responses['200'].links.self.operationId,
    ).toBe('post__read');
  });
  it('validates health-only Notification and includes routed User terms', async () => {
    const user = fixture('/api/v1/users/me');
    user.paths['/api/v1/terms'] = {
      get: { responses: { '200': { description: 'Terms' } } },
    };
    const notification = {
      openapi: '3.0.3',
      info: { title: 'Notification', version: '1' },
      paths: {
        '/health/live': {
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const doc = await mergeDocuments(
      [
        { service: 'user', document: user },
        { service: 'notification', document: notification },
      ],
      config(),
    );
    expect(Object.keys(doc.paths)).toEqual([
      '/api/v1/users/me',
      '/api/v1/terms',
    ]);
    expect(doc.paths['/api/v1/users/me'].get.security).toEqual([
      { user__UserAccess: [] },
    ]);
    expect(doc.paths['/api/v1/terms'].get.security).toEqual([]);
    expect(doc['x-services-without-public-operations']).toEqual([
      'notification',
    ]);
    expect(doc['x-undocumented-services']).toEqual([]);
    await expect(
      mergeDocuments([{ service: 'user', document: notification }], config()),
    ).rejects.toThrow('no Gateway public operations');
    await expect(
      mergeDocuments(
        [
          {
            service: 'notification',
            document: { ...notification, openapi: 'invalid' },
          },
        ],
        config(),
      ),
    ).rejects.toThrow('notification: invalid OpenAPI');
  });
  it('rejects duplicate path/method', async () => {
    await expect(
      mergeDocuments(
        [
          { service: 'post', document: fixture() },
          { service: 'map', document: fixture() },
        ],
        config(),
        [
          { service: 'post', prefix: '/api/v1/posts' },
          { service: 'map', prefix: '/api/v1/posts' },
        ],
      ),
    ).rejects.toThrow('Duplicate public operation');
  });
  it('rejects duplicate operationId within one service', async () => {
    const doc = fixture();
    doc.paths['/api/v1/posts/second'] = structuredClone(
      doc.paths['/api/v1/posts'],
    );
    await expect(
      mergeDocuments([{ service: 'post', document: doc }], config()),
    ).rejects.toThrow('Duplicate operationId');
  });
  it('rejects invalid version, schema, refs and security names', async () => {
    for (const change of [
      (d: ApiDocument) => {
        d.openapi = '3.1.0';
      },
      (d: ApiDocument) => {
        d.components.schemas.Result.type = 'invalid';
      },
      (d: ApiDocument) => {
        d.components.schemas.Result.$ref = '#/components/schemas/Missing';
      },
      (d: ApiDocument) => {
        d.components.schemas.Result.$ref = 'https://example.com/schema.json';
      },
      (d: ApiDocument) => {
        d.security = [{ Missing: [] }];
      },
    ]) {
      const doc = fixture();
      change(doc);
      await expect(validateDocument(doc)).rejects.toThrow();
    }
  });
  it('replaces upstream internal auth with client Access JWT', async () => {
    const doc = fixture();
    doc.components.securitySchemes['service-jwt'] = {
      type: 'http',
      scheme: 'bearer',
    };
    doc.security = [{ 'service-jwt': [] }];
    const merged = await mergeDocuments(
      [{ service: 'post', document: doc }],
      config(),
    );
    expect(merged.paths['/api/v1/posts'].get.security).toEqual([
      { post__UserAccess: [] },
    ]);
    expect(
      merged.components.securitySchemes['post__service-jwt'],
    ).toBeUndefined();
  });
  it('adds actual Gateway responses without replacing upstream errors', async () => {
    const cfg = config();
    cfg.rateLimit.enabled = true;
    const doc = fixture('/api/v1/location');
    doc.paths['/api/v1/location'].put = doc.paths['/api/v1/location'].get;
    delete doc.paths['/api/v1/location'].get;
    doc.paths['/api/v1/location'].put.responses['503'] = {
      description: 'Storage unavailable',
    };
    const merged = await mergeDocuments(
      [{ service: 'map', document: doc }],
      cfg,
    );
    const responses = merged.paths['/api/v1/location'].put.responses;
    expect(responses['429'].headers['Retry-After']).toBeDefined();
    expect(responses['503'].content).toBeUndefined();
    expect(responses['503']['x-gateway-response'].content).toBeDefined();
    expect(responses['413'].description).toContain('1048576');
  });
});

describe('collection and docs routes', () => {
  it('serves staging docs without an artifact and shares validated live refreshes', async () => {
    const cfg = config();
    cfg.nodeEnv = 'production';
    cfg.docs.live = true;
    cfg.docs.file = '/missing-artifact.json';
    let calls = 0;
    let fail = true;
    const upstream = Fastify();
    const paths: Record<(typeof documentedServices)[number], string> = {
      user: '/api/v1/users/me',
      post: '/api/v1/posts',
      map: '/api/v1/location',
      notification: '/api/v1/notifications',
      moderation: '/api/v1/moderation/reports',
    };
    // Match the collector so every upstream stays inside this test server.
    for (const service of documentedServices) {
      upstream.get(`/${service}/docs/openapi.json`, async (_request, reply) => {
        calls++;
        return fail
          ? reply.code(503).send()
          : service === 'user' || service === 'moderation'
            ? blocksAndReports(service)
            : fixture(paths[service]);
      });
    }
    const base = await upstream.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => upstream.close());
    for (const service of documentedServices)
      cfg.services[service] = `${base}/${service}`;
    const app = await buildApp({ config: cfg, logger: false });
    cleanup.push(() => app.close());
    expect((await app.inject('/docs')).statusCode).toBe(200);
    expect((await app.inject('/swagger-ui.html')).headers.location).toBe(
      '/docs',
    );
    expect(calls).toBe(0);
    const failed = await app.inject('/docs/openapi.json');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain(base);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    fail = false;
    const responses = await Promise.all([
      app.inject('/docs/openapi.json'),
      app.inject('/docs/openapi.json'),
    ]);
    expect(calls).toBe(documentedServices.length * 2);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json().servers).toEqual([{ url: '/' }]);
      expect(response.json().paths['/internal/test']).toBeUndefined();
      expectBlocksAndReports(response.json());
      for (const path of Object.values(paths))
        expect(response.json().paths[path]).toBeDefined();
    }
    await app.inject('/docs/openapi.json');
    expect(calls).toBe(documentedServices.length * 2);
  });
  it('collects configured URLs and preserves output on fetch/merge failure', async () => {
    const cfg = config();
    cfg.docs.file = join(await directory(), 'openapi.json');
    const upstream = Fastify();
    let bad = false,
      invalid = false;
    upstream.get('/moderation/docs/openapi.json', async () =>
      blocksAndReports('moderation'),
    );
    upstream.get('/post/docs/openapi.json', async () =>
      invalid ? { openapi: '2.0' } : fixture(),
    );
    upstream.get('/map/docs/openapi.json', async (_req, reply) =>
      bad ? reply.code(503).send() : fixture('/api/v1/location'),
    );
    upstream.get('/user/docs/openapi.json', async () =>
      blocksAndReports('user'),
    );
    upstream.get('/notification/docs/openapi.json', async () => ({
      openapi: '3.0.3',
      info: { title: 'Notification', version: '1' },
      paths: {
        '/health/live': {
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
    }));
    const base = await upstream.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => upstream.close());
    cfg.services.user = `${base}/user`;
    cfg.services.notification = `${base}/notification`;
    cfg.services.post = `${base}/post`;
    cfg.services.map = `${base}/map`;
    cfg.services.moderation = `${base}/moderation`;
    const generated = await generateDocs(cfg);
    expect(generated.paths['/api/v1/users/me'].get).toBeDefined();
    expectBlocksAndReports(generated);
    expect(generated['x-services-without-public-operations']).toEqual([
      'notification',
    ]);
    const before = await readFile(cfg.docs.file, 'utf8');
    bad = true;
    await expect(generateDocs(cfg)).rejects.toThrow(/map:.*HTTP 503/);
    expect(await readFile(cfg.docs.file, 'utf8')).toBe(before);
    bad = false;
    invalid = true;
    await expect(generateDocs(cfg)).rejects.toThrow('Unsupported OpenAPI');
    expect(await readFile(cfg.docs.file, 'utf8')).toBe(before);
  });
  it('reports service timeout and preserves output', async () => {
    const cfg = config();
    cfg.docs.timeoutMs = 30;
    cfg.docs.file = join(await directory(), 'openapi.json');
    await writeFile(cfg.docs.file, 'previous');
    const upstream = Fastify();
    upstream.get('/docs/openapi.json', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return fixture();
    });
    const base = await upstream.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => upstream.close());
    cfg.services.user = base;
    cfg.services.notification = base;
    cfg.services.post = base;
    cfg.services.map = base;
    await expect(generateDocs(cfg)).rejects.toThrow(/post:.*timeout 30 ms/);
    expect(await readFile(cfg.docs.file, 'utf8')).toBe('previous');
  });
  it('serves local assets with scoped CSP and forwards a same-origin Try it out request', async () => {
    const cfg = config();
    cfg.docs.file = join(await directory(), 'openapi.json');
    const source = fixture();
    source.security = [];
    const document = await mergeDocuments(
      [{ service: 'post', document: source }],
      cfg,
    );
    await writeFile(cfg.docs.file, JSON.stringify(document));
    const upstream = Fastify();
    upstream.get('/api/v1/posts', async (request) => ({
      user: request.headers['x-user-id'],
      requestId: request.headers['x-request-id'],
    }));
    cfg.services.post = await upstream.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => upstream.close());
    const app = await buildApp({ config: cfg, logger: false });
    cleanup.push(() => app.close());
    const page = await app.inject('/docs');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('/docs/init.js');
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    expect(page.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    for (const url of [
      '/docs/swagger-ui.css',
      '/docs/swagger-ui-bundle.js',
      '/docs/init.js',
    ])
      expect((await app.inject(url)).statusCode).toBe(200);
    const api = (await app.inject('/docs/openapi.json')).json();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const target = new URL(
      `${api.servers[0].url.replace(/\/$/, '')}${Object.keys(api.paths)[0]}`,
      address,
    );
    expect(target.origin).toBe(address);
    const response = await fetch(target, {
      headers: { 'X-User-Id': '999', authorization: frontendBearer() },
    });
    expect(await response.json()).toMatchObject({
      user: '123',
      requestId: expect.any(String),
    });
    expect(
      (await app.inject('/health/live')).headers['content-security-policy'],
    ).toContain('upgrade-insecure-requests');
  });
  it('boots without an artifact, keeping API available', async () => {
    const cfg = config();
    cfg.docs.file = join(await directory(), 'missing.json');
    const app = await buildApp({ config: cfg, logger: false });
    cleanup.push(() => app.close());
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/docs')).statusCode).toBe(200);
    expect((await app.inject('/docs/openapi.json')).statusCode).toBe(503);
    expect(
      (
        await app.inject({
          url: '/api/v1/posts',
          headers: { authorization: frontendBearer() },
        })
      ).statusCode,
    ).toBe(502);
  });
  it.each(['production', 'disabled'])(
    'registers no docs routes when %s',
    async (mode) => {
      const cfg = config();
      if (mode === 'production') cfg.nodeEnv = 'production';
      else cfg.docs.enabled = false;
      const app = await buildApp({ config: cfg, logger: false });
      cleanup.push(() => app.close());
      for (const url of [
        '/docs',
        '/docs/',
        '/docs/openapi.json',
        '/docs/swagger-ui.css',
        '/docs/swagger-ui-bundle.js',
        '/docs/init.js',
      ])
        expect((await app.inject(url)).statusCode).toBe(404);
    },
  );
  it('forces docs off in production even when configured on', () => {
    process.env = { NODE_ENV: 'production', DOCS_ENABLED: 'true' };
    expect(loadConfig().docs.enabled).toBe(false);
  });
});
