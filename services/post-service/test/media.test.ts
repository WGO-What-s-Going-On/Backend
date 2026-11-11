import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  File,
  type CopyOptions,
  type DeleteFileOptions,
} from '@google-cloud/storage';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mediaConfig } from '../src/post/media/media.config.js';
import { mediaIds } from '../src/post/media/media.policy.js';
import { GcsMediaStorage } from '../src/post/media/gcs-media.storage.js';
import type { MediaRecord } from '../src/post/media/media.schema.js';
const id = () => `media_${randomUUID()}`;
const png = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001',
  'hex',
);
const record: MediaRecord = {
  mediaId: id(),
  ownerId: 123,
  objectKey: 'post-media/objects/example',
  uploadKey: 'post-media/pending/example',
  type: 'IMAGE',
  contentType: 'image/png',
  sizeBytes: png.length,
  checksum: createHash('sha256').update(png).digest('base64'),
  status: 'PENDING',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60000),
};
function storage() {
  vi.stubEnv('GCS_MEDIA_ENABLED', 'true');
  vi.stubEnv('GCS_MEDIA_BUCKET', 'test-media-bucket');
  return new GcsMediaStorage();
}
function object(bytes = png) {
  vi.spyOn(File.prototype, 'getMetadata').mockImplementation(async () => [
    {
      size: String(record.sizeBytes),
      contentType: record.contentType,
      generation: '1720000000000001',
    },
  ]);
  const reads: File[] = [];
  const copies: { file: File; options: CopyOptions | undefined }[] = [];
  const read = vi
    .spyOn(File.prototype, 'createReadStream')
    .mockImplementation(function (this: File) {
      reads.push(this);
      return Readable.from([bytes]);
    });
  const copy = vi
    .spyOn(File.prototype, 'copy')
    .mockImplementation(async function (this: File, _destination, options) {
      copies.push({
        file: this,
        options: typeof options === 'object' ? options : undefined,
      });
      return [this, {}];
    });
  return { read, copy, reads, copies };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('media policy and configuration', () => {
  it('requires explicit enabled configuration and bounds URLs', () => {
    expect(mediaConfig({}).enabled).toBe(false);
    expect(() => mediaConfig({ GCS_MEDIA_ENABLED: 'true' })).toThrow(
      'GCS_MEDIA_BUCKET',
    );
    expect(() => mediaConfig({ GCS_MEDIA_ENABLED: 'yes' })).toThrow();
    expect(() => mediaConfig({ GCS_MEDIA_READ_TTL_SECONDS: '3601' })).toThrow();
    expect(() => mediaConfig({ GCS_MEDIA_UPLOAD_TTL_SECONDS: '4' })).toThrow();
  });
  it.each(['GOOGLE_APPLICATION_CREDENTIALS', 'STORAGE_EMULATOR_HOST'])(
    'rejects production override %s without exposing values',
    (name) => {
      expect(() =>
        mediaConfig({
          GCS_MEDIA_ENABLED: 'true',
          GCS_MEDIA_BUCKET: 'test-bucket',
          NODE_ENV: 'production',
          [name]: 'secret-value',
        }),
      ).toThrow(`${name} must be unset`);
    },
  );
  it('allows five unique IDs and rejects six, duplicates and object keys', () => {
    expect(mediaIds(undefined)).toEqual([]);
    expect(mediaIds(Array.from({ length: 5 }, id))).toHaveLength(5);
    for (const input of [
      Array.from({ length: 6 }, id),
      [record.mediaId, record.mediaId],
      ['post-media/objects/x'],
      null,
      {},
    ])
      expect(() => mediaIds(input)).toThrow();
  });
});

describe('GCS signing and verification', () => {
  it('signs exact length and create-only header, and reads only the final key', async () => {
    // Keep expiry calculation and SDK signing within the same second.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:00.999Z'));
    const s = storage();
    vi.spyOn(s.client.authClient, 'getCredentials').mockImplementation(
      async () => ({ client_email: 'post@test.iam.gserviceaccount.com' }),
    );
    vi.spyOn(s.client.authClient, 'sign').mockResolvedValue(
      Buffer.from('test-signature').toString('base64'),
    );
    const upload = await s.upload(record);
    const url = new URL(upload.url);
    expect(url.pathname).toBe('/test-media-bucket/post-media/pending/example');
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toContain(
      'content-length',
    );
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toContain(
      'x-goog-if-generation-match',
    );
    expect(upload.headers['x-goog-if-generation-match']).toBe('0');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('300');
    expect(new URL((await s.read(record)).url).pathname).toBe(
      '/test-media-bucket/post-media/objects/example',
    );
  });
  it('reuses read URLs within a window across instances and renews at the boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:01Z'));
    const first = storage();
    const second = storage();
    for (const s of [first, second]) {
      vi.spyOn(s.client.authClient, 'getCredentials').mockImplementation(
        async () => ({ client_email: 'post@test.iam.gserviceaccount.com' }),
      );
      vi.spyOn(s.client.authClient, 'sign').mockImplementation(async (data) =>
        createHash('sha256').update(data).digest('base64'),
      );
    }
    const initial = await first.read(record);
    vi.setSystemTime(new Date('2026-11-02T00:29:59Z'));
    expect(await second.read(record)).toEqual(initial);
    expect(initial.expiresAt).toBe('2026-11-02T01:00:00.000Z');
    expect(
      new URL(initial.url).searchParams.get('response-cache-control'),
    ).toBe('private, max-age=86400');
    vi.setSystemTime(new Date('2026-11-02T00:30:00Z'));
    const renewed = await first.read(record);
    expect(renewed.url).not.toBe(initial.url);
    expect(renewed.expiresAt).toBe('2026-11-02T01:30:00.000Z');
  });
  it('verifies actual SHA256 bytes and pins the generation through copy', async () => {
    const { reads, copies } = object();
    await storage().verifyAndPromote(record);
    expect(reads[0]?.generation).toBe(1720000000000001);
    expect(copies[0]?.file.generation).toBe(1720000000000001);
    expect(copies[0]?.options).toMatchObject({
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  });
  it('rejects content with correct metadata but wrong SHA256', async () => {
    const { copy } = object(Buffer.alloc(png.length));
    await expect(storage().verifyAndPromote(record)).rejects.toThrow(
      'does not match',
    );
    expect(copy).not.toHaveBeenCalled();
  });
  it('rejects excess bytes and destroys the stream', async () => {
    const stream = Readable.from([png, Buffer.from('extra')]);
    const { read, copy } = object();
    read.mockReturnValue(stream);
    await expect(storage().verifyAndPromote(record)).rejects.toThrow(
      'does not match',
    );
    expect(stream.destroyed).toBe(true);
    expect(copy).not.toHaveBeenCalled();
  });
  it('rejects MIME spoofing even when SHA256 is correct', async () => {
    const bytes = Buffer.alloc(png.length, 'a');
    const { copy } = object(bytes);
    await expect(
      storage().verifyAndPromote({
        ...record,
        checksum: createHash('sha256').update(bytes).digest('base64'),
      }),
    ).rejects.toThrow('signature');
    expect(copy).not.toHaveBeenCalled();
  });
  it('revalidates the final object after a competing or retried copy', async () => {
    const { read, copy, reads } = object();
    copy.mockRejectedValue({ code: 412 });
    await storage().verifyAndPromote(record);
    expect(reads.map((file) => file.name)).toEqual([
      record.uploadKey,
      record.objectKey,
    ]);
    read
      .mockImplementationOnce(() => Readable.from([png]))
      .mockImplementationOnce(() => Readable.from([Buffer.alloc(png.length)]));
    await expect(storage().verifyAndPromote(record)).rejects.toThrow(
      'does not match',
    );
  });
  it('sanitizes errors and classifies missing uploads', async () => {
    const metadata = vi
      .spyOn(File.prototype, 'getMetadata')
      .mockRejectedValue({ code: 404 });
    await expect(storage().verifyAndPromote(record)).rejects.toThrow(
      'Upload has not completed',
    );
    metadata.mockRejectedValue(new Error('secret-value'));
    await expect(storage().verifyAndPromote(record)).rejects.toThrow(
      'Media verification unavailable',
    );
  });
  it('deletes both keys idempotently and preserves failure for worker retry', async () => {
    const calls: { file: File; options: DeleteFileOptions | undefined }[] = [];
    const remove = vi
      .spyOn(File.prototype, 'delete')
      .mockImplementation(async function (this: File, options) {
        calls.push({
          file: this,
          options: typeof options === 'object' ? options : undefined,
        });
        return [{}];
      });
    await storage().remove(record);
    expect(calls.map(({ file }) => file.name)).toEqual([
      record.uploadKey,
      record.objectKey,
    ]);
    expect(calls.every(({ options }) => options?.ignoreNotFound)).toBe(true);
    remove.mockRejectedValue(new Error('secret-value'));
    await expect(storage().remove(record)).rejects.toThrow(
      'Media deletion unavailable',
    );
  });
});
