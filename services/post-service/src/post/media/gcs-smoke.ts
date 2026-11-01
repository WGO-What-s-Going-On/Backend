import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { GcsMediaStorage } from './gcs-media.storage.js';
import type { MediaRecord } from './media.schema.js';

const storage = new GcsMediaStorage();
storage.requireEnabled();
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0Z8AAAAASUVORK5CYII=',
  'base64',
);
const mediaId = `media_${randomUUID()}`;
const record: MediaRecord = {
  mediaId,
  ownerId: 1,
  type: 'IMAGE',
  contentType: 'image/png',
  sizeBytes: bytes.length,
  checksum: createHash('sha256').update(bytes).digest('base64'),
  status: 'PENDING',
  objectKey: `post-media/objects/${mediaId}`,
  uploadKey: `post-media/pending/${mediaId}`,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60000),
};
try {
  const target = await storage.upload(record);
  const uploaded = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
  await uploaded.body?.cancel();
  assert.equal(
    uploaded.ok,
    true,
    `GCS upload failed with status ${uploaded.status}`,
  );
  const duplicate = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
  await duplicate.body?.cancel();
  assert.equal(
    duplicate.status,
    412,
    'A signed upload must not overwrite an existing object',
  );
  await storage.verifyAndPromote(record);
  await storage.verifyAndPromote(record);
  const targetRead = await storage.read(record);
  const downloaded = await fetch(targetRead.url, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    downloaded.ok,
    true,
    `GCS download failed with status ${downloaded.status}`,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  process.stdout.write(
    'GCS signed upload, create-only condition, verified promotion, retry and download passed\n',
  );
} finally {
  await storage.remove(record);
}
