import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';

const require = createRequire(import.meta.url);
const page = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>WGO Public HTTP API</title>
<link rel="stylesheet" href="/docs/swagger-ui.css"></head><body>
<p>로컬·dev 공개 HTTP API · <a href="https://github.com/WGO-What-s-Going-On/Backend/blob/dev/gateways/ws-gateway/README.md">기존 WebSocket 계약</a></p>
<div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/init.js"></script></body></html>`;

export async function registerDocs(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  // The environment guard also protects callers that supply config directly.
  if (config.nodeEnv === 'production' || !config.docs.enabled) return;
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
      const document = JSON.parse(await readFile(config.docs.file, 'utf8'));
      return reply.header('Cache-Control', 'no-store').send(document);
    } catch (error) {
      request.log.warn({ err: error }, 'Gateway OpenAPI artifact unavailable');
      return reply.code(503).send({
        code: 'GATEWAY_DOCS_UNAVAILABLE',
        message: 'Run pnpm docs:generate from the HTTP Gateway directory.',
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    }
  });
}
