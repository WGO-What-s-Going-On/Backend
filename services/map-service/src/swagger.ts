import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const assets: Record<string, { file: string; type: string }> = {
  '/docs/swagger-ui.css': {
    file: 'swagger-ui.css',
    type: 'text/css; charset=utf-8',
  },
  '/docs/swagger-ui-bundle.js': {
    file: 'swagger-ui-bundle.js',
    type: 'text/javascript; charset=utf-8',
  },
};

const page = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>WGO Map Service API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/docs/openapi.json',dom_id:'#swagger-ui'});</script></body>
</html>`;

export async function serveSwagger(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.method !== 'GET') return false;
  if (request.url === '/docs' || request.url === '/docs/') {
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(page);
    return true;
  }
  const asset = assets[request.url ?? ''];
  const file =
    request.url === '/docs/openapi.json'
      ? {
          file: resolve(process.cwd(), 'contracts/map-http.openapi.json'),
          type: 'application/json; charset=utf-8',
        }
      : asset && {
          file: resolve(
            process.cwd(),
            'node_modules/swagger-ui-dist',
            asset.file,
          ),
          type: asset.type,
        };
  if (!file) return false;
  try {
    const content = await readFile(file.file);
    response.writeHead(200, { 'content-type': file.type }).end(content);
  } catch {
    response.writeHead(503).end();
  }
  return true;
}
