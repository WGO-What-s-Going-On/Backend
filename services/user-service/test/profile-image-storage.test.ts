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
    const id = randomUUID();
    return Object.assign(new ProfileImageUploadEntity(), {
      id,
      contentType,
      sizeBytes: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('base64'),
      uploadKey: `user-profiles/pending/${id}`,
      objectKey: `user-profiles/objects/${id}`,
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
  it.each(['uploadKey', 'objectKey', 'id'] as const)(
    'rejects a mismatched %s before signing or copying',
    async (field) => {
      const row = record(Buffer.alloc(10));
      row[field] =
        field === 'id' ? randomUUID() : `post-media/objects/media_${row.id}`;
      await expect(storage.upload(row)).rejects.toThrow(
        'Invalid managed profile image',
      );
      await expect(storage.verifyAndPromote(row)).rejects.toThrow(
        'Invalid managed profile image',
      );
      await expect(storage.remove(row, 'pending')).rejects.toThrow(
        'Invalid managed profile image',
      );
      await expect(storage.remove(row, 'object')).rejects.toThrow(
        'Invalid managed profile image',
      );
      expect(storage.client.bucket).not.toHaveBeenCalled();
    },
  );
  it.each([
    'post-media/objects/media_123',
    'legacy/image',
    'user-profiles/objects/not-a-uuid',
    `user-profiles/objects/${randomUUID()}/extra`,
    `user-profiles/objects/${randomUUID()}`,
    `user-profiles/pending/../objects/${randomUUID()}`,
  ])('never deletes an unmanaged key %s', async (key) => {
    fake.put(key, Buffer.alloc(10));
    const row = record(Buffer.alloc(10));
    row.objectKey = key;
    await expect(storage.remove(row, 'object')).rejects.toThrow(
      'Invalid managed profile image',
    );
    expect(fake.objects.has(key)).toBe(true);
    expect(storage.client.bucket).not.toHaveBeenCalled();
  });
  it.each(['legacy/image', 'user-profiles/legacy/avatar.png'])(
    'reads legacy key %s without rewriting or deleting it',
    async (key) => {
      await storage.read(key);
      expect(fake.signed.at(-1)).toMatchObject({ key, action: 'read' });
    },
  );
  it('treats signBlob permission independently of object permissions', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const row = record(bytes);
    fake.put(row.uploadKey, bytes);
    fake.signingDenied = true;
    await expect(storage.upload(row)).rejects.toThrow('signing unavailable');
    await expect(storage.read(row.objectKey)).rejects.toThrow(
      'signing unavailable',
    );
    await storage.verifyAndPromote(row);
    expect(fake.objects.get(row.objectKey)?.bytes).toEqual(bytes);
  });
  it('does not confuse successful URL signing with permission to read/copy/delete objects', async () => {
    const row = record(Buffer.alloc(10));
    fake.objectAccessDenied = true;
    await expect(storage.upload(row)).resolves.toMatchObject({
      uploadId: row.id,
    });
    await expect(storage.verifyAndPromote(row)).rejects.toThrow(
      'verification unavailable',
    );
    await expect(storage.remove(row, 'pending')).rejects.toThrow(
      'deletion unavailable',
    );
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
    await expect(
      storage.remove(record(Buffer.alloc(10)), 'pending'),
    ).rejects.toThrow('deletion unavailable');
  });
});
