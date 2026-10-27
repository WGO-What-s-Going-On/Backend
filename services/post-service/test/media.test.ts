import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaConfig } from '../src/post/media/media.config.js';
import { mediaIds } from '../src/post/media/media.policy.js';
import { S3MediaStorage } from '../src/post/media/s3-media.storage.js';
import type { MediaRecord } from '../src/post/media/media.schema.js';
import {
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
const id = () => `media_${randomUUID()}`;
const record: MediaRecord = {
  mediaId: id(),
  ownerId: 123,
  objectKey: 'post-media/objects/example',
  uploadKey: 'post-media/pending/example',
  type: 'IMAGE',
  contentType: 'image/png',
  sizeBytes: 24,
  checksum: Buffer.alloc(32).toString('base64'),
  status: 'PENDING',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60000),
};
function storage() {
  vi.stubEnv('S3_MEDIA_ENABLED', 'true');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.stubEnv('S3_MEDIA_BUCKET', 'test-media-bucket');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
  return new S3MediaStorage();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('media policy and configuration', () => {
  it('keeps local media optional and requires explicit enabled configuration', () => {
    expect(mediaConfig({}).enabled).toBe(false);
    expect(() => mediaConfig({ S3_MEDIA_ENABLED: 'true' })).toThrow(
      'AWS_REGION',
    );
    expect(() => mediaConfig({ S3_MEDIA_ENABLED: 'yes' })).toThrow();
    expect(() => mediaConfig({ S3_MEDIA_READ_TTL_SECONDS: '901' })).toThrow();
    expect(() => mediaConfig({ S3_MEDIA_UPLOAD_TTL_SECONDS: '4' })).toThrow();
  });
  it.each([
    'S3_MEDIA_ENDPOINT',
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
  ])('rejects production override %s without exposing its value', (name) => {
    expect(() =>
      mediaConfig({
        S3_MEDIA_ENABLED: 'true',
        AWS_REGION: 'ap-northeast-2',
        S3_MEDIA_BUCKET: 'test-bucket',
        NODE_ENV: 'production',
        [name]: 'secret-value',
      }),
    ).toThrow(`${name} must be unset`);
  });
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
describe('S3 signing and verification', () => {
  it('signs exact length, checksum, content type and conditional upload; reads the final key', async () => {
    const s = storage();
    const upload = await s.upload(record);
    const url = new URL(upload.url);
    expect(url.pathname).toBe('/post-media/pending/example');
    const signed = url.searchParams.get('X-Amz-SignedHeaders');
    for (const name of [
      'content-length',
      'content-type',
      'if-none-match',
      'x-amz-checksum-sha256',
    ])
      expect(signed).toContain(name);
    expect(upload.headers['If-None-Match']).toBe('*');
    expect(new URL((await s.read(record)).url).pathname).toBe(
      '/post-media/objects/example',
    );
    s.onModuleDestroy();
  });
  it('caps URL expiry at temporary credential expiry', async () => {
    const s = storage();
    s.client.config.credentials = async () => ({
      accessKeyId: 'test',
      secretAccessKey: 'test',
      sessionToken: 'test',
      expiration: new Date(Date.now() + 45000),
    });
    const upload = await s.upload(record);
    expect(
      Number(new URL(upload.url).searchParams.get('X-Amz-Expires')),
    ).toBeLessThanOrEqual(40);
    s.onModuleDestroy();
  });
  it('checks S3 metadata and magic bytes before copying to the final key', async () => {
    const s = storage();
    const send = vi
      .spyOn(s.client, 'send')
      .mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand)
          return {
            ContentLength: 24,
            ContentType: 'image/png',
            ChecksumSHA256: record.checksum,
            ETag: 'etag',
          };
        if (command instanceof GetObjectCommand)
          return {
            Body: {
              transformToByteArray: async () =>
                Buffer.from(
                  '89504e470d0a1a0a0000000d494844520000000100000001',
                  'hex',
                ),
            },
          };
        return {};
      });
    await s.verifyAndPromote(record);
    expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(CopyObjectCommand);
    expect(
      (send.mock.calls.at(-1)?.[0] as CopyObjectCommand).input
        .CopySourceIfMatch,
    ).toBe('etag');
    send.mockImplementation(async () => ({ ContentLength: 999 }));
    await expect(s.verifyAndPromote(record)).rejects.toThrow('does not match');
    expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(HeadObjectCommand);
    s.onModuleDestroy();
  });
  it('rejects spoofed MIME and sanitizes dependency errors', async () => {
    const s = storage();
    const send = vi
      .spyOn(s.client, 'send')
      .mockImplementation(async (command: any) =>
        command instanceof HeadObjectCommand
          ? {
              ContentLength: 24,
              ContentType: 'image/png',
              ChecksumSHA256: record.checksum,
              ETag: 'etag',
            }
          : {
              Body: {
                transformToByteArray: async () =>
                  Buffer.from('<html>not an image</html>'),
              },
            },
      );
    await expect(s.verifyAndPromote(record)).rejects.toThrow('signature');
    expect(send.mock.calls.some(([c]) => c instanceof CopyObjectCommand)).toBe(
      false,
    );
    send.mockRejectedValue(new Error('secret-value'));
    await expect(s.verifyAndPromote(record)).rejects.toThrow(
      'Media verification unavailable',
    );
    s.onModuleDestroy();
  });
});
