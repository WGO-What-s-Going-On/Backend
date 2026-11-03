import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Storage, type File } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { ProfileImageUploadEntity } from '../../database/entities/profile-image-upload.entity.js';
import {
  IMAGE_URL_SECONDS,
  profileImageConfig,
} from './profile-image.config.js';

function hasCode(error: unknown, code: number) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String(error.code) === String(code)
  );
}

@Injectable()
export class GcsProfileImageStorage {
  readonly config = profileImageConfig();
  readonly client = new Storage({
    timeout: 15000,
    retryOptions: { maxRetries: 2, totalTimeout: 30 },
  });

  requireEnabled() {
    if (!this.config.enabled)
      throw new ServiceUnavailableException(
        'Profile image storage is disabled',
      );
  }

  async upload(record: ProfileImageUploadEntity) {
    this.requireEnabled();
    const expires = record.expiresAt;
    const headers = {
      'Content-Type': record.contentType,
      'x-goog-if-generation-match': '0',
    };
    try {
      const [uploadUrl] = await this.client
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
        uploadId: record.id,
        uploadUrl,
        method: 'PUT' as const,
        headers,
        expiresAt: expires.toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException(
        'Profile image signing unavailable',
      );
    }
  }

  private async verifiedFile(
    key: string,
    record: ProfileImageUploadEntity,
  ): Promise<File> {
    const bucket = this.client.bucket(this.config.bucket);
    const [metadata] = await bucket.file(key).getMetadata();
    if (
      Number(metadata.size) !== record.sizeBytes ||
      metadata.contentType !== record.contentType ||
      !metadata.generation ||
      !Number.isSafeInteger(Number(metadata.generation))
    )
      throw new UnprocessableEntityException(
        'Uploaded image metadata mismatch',
      );
    // Verification and promotion use the same immutable generation.
    const file = bucket.file(key, { generation: metadata.generation });
    const stream = file.createReadStream({
      validation: 'crc32c',
      decompress: false,
    });
    const timer = setTimeout(
      () => stream.destroy(new Error('Image read timed out')),
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
            'Uploaded image size mismatch',
          );
        hash.update(chunk);
        if (prefix.length < 8192)
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, 8192 - prefix.length),
          ]);
      }
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
    if (
      length !== record.sizeBytes ||
      hash.digest('base64') !== record.checksum
    )
      throw new UnprocessableEntityException(
        'Uploaded image checksum or size mismatch',
      );
    // Signature validation is not a full image decoder or malware scanner.
    const detected = await fileTypeFromBuffer(prefix).catch(() => undefined);
    if (detected?.mime !== record.contentType)
      throw new UnprocessableEntityException(
        'Uploaded image signature mismatch',
      );
    return file;
  }

  async verifyAndPromote(record: ProfileImageUploadEntity) {
    this.requireEnabled();
    try {
      // A copy may succeed even when its response or the following DB commit is lost.
      try {
        await this.verifiedFile(record.objectKey, record);
        return;
      } catch (error) {
        if (!hasCode(error, 404)) throw error;
      }
      const source = await this.verifiedFile(record.uploadKey, record);
      try {
        await source.copy(
          this.client.bucket(this.config.bucket).file(record.objectKey),
          {
            preconditionOpts: { ifGenerationMatch: 0 },
            contentType: record.contentType,
            contentDisposition: 'inline',
            cacheControl: 'private, no-store',
            contentEncoding: 'identity',
          },
        );
      } catch (error) {
        if (!hasCode(error, 412)) throw error;
        await this.verifiedFile(record.objectKey, record);
      }
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      if (hasCode(error, 404))
        throw new UnprocessableEntityException('Upload has not completed');
      throw new ServiceUnavailableException(
        'Profile image verification unavailable',
      );
    }
  }

  async read(key: string) {
    this.requireEnabled();
    const expires = new Date(Date.now() + IMAGE_URL_SECONDS * 1000);
    try {
      const [url] = await this.client
        .bucket(this.config.bucket)
        .file(key)
        .getSignedUrl({
          version: 'v4',
          action: 'read',
          expires,
          responseDisposition: 'inline',
          queryParams: { 'response-cache-control': 'private, no-store' },
        });
      return { profileImageKey: key, url, expiresAt: expires.toISOString() };
    } catch {
      throw new ServiceUnavailableException(
        'Profile image signing unavailable',
      );
    }
  }

  async remove(key: string) {
    this.requireEnabled();
    try {
      await this.client
        .bucket(this.config.bucket)
        .file(key)
        .delete({ ignoreNotFound: true });
    } catch {
      throw new ServiceUnavailableException(
        'Profile image deletion unavailable',
      );
    }
  }
}
