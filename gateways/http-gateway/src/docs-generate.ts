import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig, type AppConfig } from './config.js';
import {
  documentedServices,
  undocumentedServices,
  mergeDocuments,
  type ApiDocument,
} from './openapi.js';

export async function collectDocs(config: AppConfig): Promise<ApiDocument> {
  const results = await Promise.allSettled(
    documentedServices.map(async (service) => {
      const url = `${config.services[service]}/docs/openapi.json`;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(config.docs.timeoutMs),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { service, document: (await response.json()) as ApiDocument };
      } catch (error) {
        throw new Error(
          `${service}: ${url} (timeout ${config.docs.timeoutMs} ms): ${error instanceof Error ? error.message : error}`,
        );
      }
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new Error(
      failures
        .map((result) => (result as PromiseRejectedResult).reason.message)
        .join('\n'),
    );
  const sources = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  return mergeDocuments(sources, config);
}

export async function generateDocs(config: AppConfig): Promise<ApiDocument> {
  if (config.nodeEnv === 'production')
    throw new Error('Documentation generation is development-only');
  const document = await collectDocs(config);
  const file = resolve(config.docs.file);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    // Commit only after every supported service and the merged contract validate.
    await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', {
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return document;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    try {
      loadEnvFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const config = loadConfig();
    const document = await generateDocs(config);
    console.info(
      `Generated ${config.docs.file}: ${Object.keys(document.paths).length} public paths (${documentedServices.join(', ')}). No public operations: ${document['x-services-without-public-operations'].join(', ') || 'none'}. Undocumented: ${undocumentedServices.join(', ')}.`,
    );
  } catch (error) {
    console.error(
      `OpenAPI generation failed; existing document preserved.\n${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
