import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Storage, type File } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { mediaConfig } from './media.config.js';
import type { MediaRecord } from './media.schema.js';

function hasCode(error: unknown, code: number) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === code || error.code === String(code))
  );
}

@Injectable()
export class GcsMediaStorage {
  readonly config = mediaConfig();
  readonly client = new Storage({
    timeout: 15000,
    retryOptions: { maxRetries: 2, totalTimeout: 30 },
  });

  requireEnabled() {
    if (!this.config.enabled)
      throw new ServiceUnavailableException('Media storage is disabled');
  }

  private expiry(seconds: number) {
    this.requireEnabled();
    return new Date(Date.now() + seconds * 1000);
  }

  async upload(record: MediaRecord) {
    const expires = this.expiry(this.config.uploadSeconds);
    const headers = {
      'Content-Type': record.contentType,
      'x-goog-if-generation-match': '0',
    };
    try {
      const [url] = await this.client
        .bucket(this.config.bucket)
        .file(record.uploadKey)
        .getSignedUrl({
          version: 'v4',
          action: 'write',
          expires,
          contentType: record.contentType,
          extensionHeaders: {
            'content-length': String(record.sizeBytes),
            'x-goog-if-generation-match': '0',
          },
        });
      return {
        url,
        expiresAt: expires.toISOString(),
        method: 'PUT' as const,
        headers,
      };
    } catch {
      throw new ServiceUnavailableException('Media signing unavailable');
    }
  }

  private async verifiedFile(key: string, record: MediaRecord): Promise<File> {
    const bucket = this.client.bucket(this.config.bucket);
    const [metadata] = await bucket.file(key).getMetadata();
    if (
      Number(metadata.size) !== record.sizeBytes ||
      metadata.contentType !== record.contentType ||
      !metadata.generation ||
      !Number.isSafeInteger(Number(metadata.generation))
    )
      throw new UnprocessableEntityException(
        'Uploaded media does not match the declared file',
      );
    // Read and copy the same immutable generation, even if an object changes during verification.
    const file = bucket.file(key, { generation: metadata.generation });
    const stream = file.createReadStream({
      validation: 'crc32c',
      decompress: false,
    });
    const timeout = setTimeout(
      () => stream.destroy(new Error('Media read timed out')),
      15000,
    );
    const hash = createHash('sha256');
    let length = 0;
    let prefix = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid object bytes');
        length += chunk.length;
        if (length > record.sizeBytes)
          throw new UnprocessableEntityException(
            'Uploaded media does not match the declared file',
          );
        hash.update(chunk);
        if (prefix.length < 8192)
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, 8192 - prefix.length),
          ]);
      }
    } finally {
      clearTimeout(timeout);
      stream.destroy();
    }
    if (
      length !== record.sizeBytes ||
      hash.digest('base64') !== record.checksum
    )
      throw new UnprocessableEntityException(
        'Uploaded media does not match the declared file',
      );
    // Magic-byte checks do not replace full decoding or malware scanning.
    const detected = await fileTypeFromBuffer(prefix).catch(() => undefined);
    if (detected?.mime !== record.contentType)
      throw new UnprocessableEntityException(
        'Unsupported or mismatched media signature',
      );
    return file;
  }

  async verifyAndPromote(record: MediaRecord) {
    this.requireEnabled();
    try {
      const source = await this.verifiedFile(record.uploadKey, record);
      try {
        await source.copy(
          this.client.bucket(this.config.bucket).file(record.objectKey),
          {
            preconditionOpts: { ifGenerationMatch: 0 },
            contentType: record.contentType,
            contentDisposition: 'inline',
            cacheControl: 'private, max-age=60',
            contentEncoding: 'identity',
          },
        );
      } catch (error) {
        if (!hasCode(error, 412)) throw error;
        // A successful copy can outlive a lost response or a competing complete request.
        await this.verifiedFile(record.objectKey, record);
      }
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      if (hasCode(error, 404))
        throw new UnprocessableEntityException('Upload has not completed');
      throw new ServiceUnavailableException('Media verification unavailable');
    }
  }

  async read(record: MediaRecord) {
    const expires = this.expiry(this.config.readSeconds);
    try {
      const [url] = await this.client
        .bucket(this.config.bucket)
        .file(record.objectKey)
        .getSignedUrl({
          version: 'v4',
          action: 'read',
          expires,
          responseType: record.contentType,
          responseDisposition: 'inline',
          queryParams: { 'response-cache-control': 'private, max-age=60' },
        });
      return {
        mediaId: record.mediaId,
        type: record.type,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        url,
        expiresAt: expires.toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException('Media signing unavailable');
    }
  }

  async remove(record: MediaRecord) {
    this.requireEnabled();
    try {
      for (const key of [record.uploadKey, record.objectKey])
        await this.client
          .bucket(this.config.bucket)
          .file(key)
          .delete({ ignoreNotFound: true });
    } catch {
      throw new ServiceUnavailableException('Media deletion unavailable');
    }
  }
}
