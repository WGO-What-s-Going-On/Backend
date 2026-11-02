import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsProfileImageStorage } from '../src/users/profile-image/gcs-profile-image.storage.js';
import { ProfileImageUploadEntity } from '../src/database/entities/profile-image-upload.entity.js';
import { FakeGcs } from './profile-image.fake-gcs.js';

describe('Profile image GCS adapter with byte-level fake', () => {
  let storage: GcsProfileImageStorage;
  let fake: FakeGcs;
  beforeEach(() => {
    storage = new GcsProfileImageStorage();
    fake = new FakeGcs();
    fake.bind(storage);
  });
  afterEach(() => vi.restoreAllMocks());
  function record(bytes: Buffer, contentType = 'image/png') {
    return Object.assign(new ProfileImageUploadEntity(), {
      id: randomUUID(),
      contentType,
      sizeBytes: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('base64'),
      uploadKey: 'pending/test',
      objectKey: 'objects/test',
      expiresAt: new Date(Date.now() + 300000),
    });
  }
  it.each([
    [
      'image/png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    ],
    [
      'image/jpeg',
      Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1,
      ]),
    ],
    [
      'image/webp',
      Buffer.from(
        '52494646220000005745425056503820160000000000000000000000000000000000000000000000',
        'hex',
      ),
    ],
  ])('verifies and promotes allowed magic bytes %s', async (mime, bytes) => {
    const row = record(bytes, mime);
    fake.put(row.uploadKey, bytes, mime);
    await storage.verifyAndPromote(row);
    expect(fake.objects.get(row.objectKey)?.bytes).toEqual(bytes);
  });
  it('rejects truncated streams even if declared metadata length matches', async () => {
    const bytes = Buffer.alloc(100);
    const row = record(bytes);
    fake.put(row.uploadKey, bytes.subarray(0, 20));
    fake.objects.get(row.uploadKey)!.declaredSize = row.sizeBytes;
    await expect(storage.verifyAndPromote(row)).rejects.toThrow(
      'checksum or size',
    );
  });
  it('rejects an oversized stream without buffering the complete object', async () => {
    const row = record(Buffer.alloc(10));
    fake.put(row.uploadKey, Buffer.alloc(100));
    fake.objects.get(row.uploadKey)!.declaredSize = row.sizeBytes;
    await expect(storage.verifyAndPromote(row)).rejects.toThrow(
      'size mismatch',
    );
  });
  it('maps signing and deletion outages to generic errors without URLs', async () => {
    fake.unavailable = true;
    await expect(storage.upload(record(Buffer.alloc(10)))).rejects.toThrow(
      'signing unavailable',
    );
    await expect(storage.read('objects/test')).rejects.toThrow(
      'signing unavailable',
    );
    await expect(storage.remove('pending/test')).rejects.toThrow(
      'deletion unavailable',
    );
  });
});
