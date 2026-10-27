import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { expect, it } from 'vitest';
import { validateRuntimeFiles } from '../src/runtime-files.js';

it('checks CA readability/PEM before startup and never leaks the URI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wgo-post-ca-'));
  try {
    const path = join(directory, 'ca.pem');
    await writeFile(path, rootCertificates[0]!);
    await expect(
      validateRuntimeFiles({
        SEMANTIC_ENABLED: 'false',
        NODE_EXTRA_CA_CERTS: path,
        MONGODB_URI: `mongodb://user:password@db.example/test?tlsCAFile=${path}`,
      }),
    ).resolves.toBeUndefined();
    await writeFile(path, 'invalid');
    await expect(
      validateRuntimeFiles({
        SEMANTIC_ENABLED: 'false',
        NODE_EXTRA_CA_CERTS: path,
      }),
    ).rejects.toThrow('NODE_EXTRA_CA_CERTS');
    await expect(
      validateRuntimeFiles({
        SEMANTIC_ENABLED: 'false',
        MONGODB_URI: `mongodb://user:do-not-print@db.example/test?tlsCAFile=${path}`,
      }),
    ).rejects.toThrow('MONGODB_URI tlsCAFile must reference');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('requires actual model files when enabled; explicit disable skips model validation', async () => {
  await expect(
    validateRuntimeFiles({ SEMANTIC_MODEL_PATH: '/absent-model' }),
  ).rejects.toThrow();
  await expect(
    validateRuntimeFiles({
      SEMANTIC_MODEL_ENABLED: 'false',
      SEMANTIC_MODEL_PATH: '/absent-model',
    }),
  ).resolves.toBeUndefined();
});

it('fails production startup on missing storage settings or TLS bypass', async () => {
  await expect(
    validateRuntimeFiles({ NODE_ENV: 'production' }),
  ).rejects.toThrow('MONGODB_URI');
  await expect(
    validateRuntimeFiles({
      NODE_ENV: 'production',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }),
  ).rejects.toThrow('TLS verification');
  const base = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://db.example/test?tls=true&tlsCAFile=/absent',
  };
  await expect(
    validateRuntimeFiles({
      ...base,
      MONGODB_URI: `${base.MONGODB_URI}&tlsInsecure=true`,
    }),
  ).rejects.toThrow('TLS verification');
  await expect(validateRuntimeFiles(base)).rejects.toThrow('ELASTICSEARCH_URL');
  await expect(
    validateRuntimeFiles({
      ...base,
      ELASTICSEARCH_URL: 'http://search.example:9200',
    }),
  ).rejects.toThrow('HTTPS');
  await expect(
    validateRuntimeFiles({
      ...base,
      ELASTICSEARCH_URL: 'https://search.example:9200',
    }),
  ).rejects.toThrow('ELASTICSEARCH_API_KEY');
});
