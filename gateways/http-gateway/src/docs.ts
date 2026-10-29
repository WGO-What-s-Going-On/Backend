import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { collectDocs } from './docs-generate.js';
import type { ApiDocument } from './openapi.js';

const require = createRequire(import.meta.url);
const page = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>WGO Public HTTP API</title>
<link rel="stylesheet" href="/docs/swagger-ui.css"></head><body>
<p>공개 HTTP API · <a href="https://github.com/WGO-What-s-Going-On/Backend/blob/main/gateways/ws-gateway/README.md">기존 WebSocket 계약</a></p>
<div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/init.js"></script></body></html>`;

export async function registerDocs(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  // The environment guard also protects callers that supply config directly.
  if (
    (config.nodeEnv === 'production' && !config.docs.live) ||
    !config.docs.enabled
  )
    return;
  let cached: ApiDocument | undefined;
  let expiresAt = 0;
  let pending: Promise<ApiDocument> | undefined;
  async function liveDocument(): Promise<ApiDocument> {
    if (cached && Date.now() < expiresAt) return cached;
    // Share concurrent refreshes; a partial or failed merge must never replace the document.
    pending ??= collectDocs(config)
      .then((document) => {
        cached = document;
        expiresAt = Date.now() + 60_000;
        return document;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  const assetRoot = dirname(require.resolve('swagger-ui-dist/package.json'));
  const options = {
    config: { rateLimit: false },
    helmet: {
      contentSecurityPolicy: {
        directives: {
          // Local HTTP must not be upgraded; all scripts and Try it out stay same-origin.
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          upgradeInsecureRequests: null,
        },
      },
    },
  };
  app.get('/swagger-ui.html', options, async (_request, reply) =>
    reply.redirect('/docs'),
  );
  app.get('/docs', options, async (_request, reply) =>
    reply.type('text/html').send(page),
  );
  app.get('/docs/', options, async (_request, reply) =>
    reply.type('text/html').send(page),
  );
  app.get('/docs/init.js', options, async (_request, reply) =>
    reply
      .type('text/javascript')
      .send(
        "SwaggerUIBundle({url:'/docs/openapi.json',dom_id:'#swagger-ui',validatorUrl:null});",
      ),
  );
  for (const [file, type] of [
    ['swagger-ui.css', 'text/css'],
    ['swagger-ui-bundle.js', 'text/javascript'],
  ]) {
    app.get(`/docs/${file}`, options, async (_request, reply) =>
      reply.type(type!).send(await readFile(join(assetRoot, file!))),
    );
  }
  app.get('/docs/openapi.json', options, async (request, reply) => {
    try {
      const document = config.docs.live
        ? await liveDocument()
        : JSON.parse(await readFile(config.docs.file, 'utf8'));
      return reply.header('Cache-Control', 'no-store').send(document);
    } catch (error) {
      request.log.warn({ err: error }, 'Gateway OpenAPI artifact unavailable');
      return reply.code(503).send({
        code: 'GATEWAY_DOCS_UNAVAILABLE',
        message: config.docs.live
          ? 'Public API documentation is temporarily unavailable.'
          : 'Run pnpm docs:generate from the HTTP Gateway directory.',
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    }
  });
}
