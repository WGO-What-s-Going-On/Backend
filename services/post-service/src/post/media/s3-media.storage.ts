import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import { mediaConfig } from './media.config.js';
import type { MediaRecord } from './media.schema.js';

@Injectable()
export class S3MediaStorage {
  readonly config = mediaConfig();
  readonly client = new S3Client({
    region: this.config.region,
    maxAttempts: 2,
    ...(this.config.endpoint
      ? { endpoint: this.config.endpoint, forcePathStyle: true }
      : {}),
  });
  requireEnabled() {
    if (!this.config.enabled)
      throw new ServiceUnavailableException('Media storage is disabled');
  }
  private async validity(seconds: number) {
    this.requireEnabled();
    try {
      const credentials = await this.client.config.credentials();
      const remaining = credentials.expiration
        ? Math.floor((credentials.expiration.getTime() - Date.now()) / 1000) - 5
        : seconds;
      const expiresIn = Math.min(seconds, remaining);
      if (expiresIn < 5) throw new Error();
      return {
        expiresIn,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException('Media signing unavailable');
    }
  }
  async upload(record: MediaRecord) {
    const validity = await this.validity(this.config.uploadSeconds);
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: record.uploadKey,
          ContentType: record.contentType,
          ContentLength: record.sizeBytes,
          ChecksumSHA256: record.checksum,
          IfNoneMatch: '*',
        }),
        {
          expiresIn: validity.expiresIn,
          signableHeaders: new Set([
            'content-type',
            'content-length',
            'if-none-match',
          ]),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      );
      return {
        url,
        expiresAt: validity.expiresAt,
        method: 'PUT' as const,
        headers: {
          'Content-Type': record.contentType,
          'x-amz-checksum-sha256': record.checksum,
          'If-None-Match': '*',
        },
      };
    } catch {
      throw new ServiceUnavailableException('Media signing unavailable');
    }
  }
  async verifyAndPromote(record: MediaRecord) {
    this.requireEnabled();
    const signal = AbortSignal.timeout(15000);
    try {
      const source = { Bucket: this.config.bucket, Key: record.uploadKey };
      const head = await this.client.send(
        new HeadObjectCommand({ ...source, ChecksumMode: 'ENABLED' }),
        { abortSignal: signal },
      );
      if (
        head.ContentLength !== record.sizeBytes ||
        head.ContentType !== record.contentType ||
        head.ChecksumSHA256 !== record.checksum ||
        !head.ETag
      )
        throw new UnprocessableEntityException(
          'Uploaded media does not match the declared file',
        );
      const object = await this.client.send(
        new GetObjectCommand({
          ...source,
          Range: 'bytes=0-8191',
          IfMatch: head.ETag,
        }),
        { abortSignal: signal },
      );
      // 제한된 파일 헤더 검사다. 전체 디코딩·동영상 변환·악성코드 검사를 대체하지 않는다.
      const bytes = await object.Body?.transformToByteArray();
      let detected;
      try {
        detected = bytes && (await fileTypeFromBuffer(bytes));
      } catch {
        detected = undefined;
      }
      if (detected?.mime !== record.contentType)
        throw new UnprocessableEntityException(
          'Unsupported or mismatched media signature',
        );
      // 브라우저는 pending 경로에만 쓴다. 조회에는 검증한 별도 복사본만 사용한다.
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          Key: record.objectKey,
          CopySource: `${this.config.bucket}/${record.uploadKey.split('/').map(encodeURIComponent).join('/')}`,
          CopySourceIfMatch: head.ETag,
          MetadataDirective: 'REPLACE',
          ContentType: record.contentType,
          ContentDisposition: 'inline',
          CacheControl: 'private, max-age=60',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        throw new UnprocessableEntityException('Upload has not completed');
      throw new ServiceUnavailableException('Media verification unavailable');
    }
  }
  async read(record: MediaRecord) {
    const validity = await this.validity(this.config.readSeconds);
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: record.objectKey,
          ResponseContentType: record.contentType,
          ResponseContentDisposition: 'inline',
          ResponseCacheControl: 'private, max-age=60',
        }),
        { expiresIn: validity.expiresIn },
      );
      return {
        mediaId: record.mediaId,
        type: record.type,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        url,
        expiresAt: validity.expiresAt,
      };
    } catch {
      throw new ServiceUnavailableException('Media signing unavailable');
    }
  }
  async remove(record: MediaRecord) {
    this.requireEnabled();
    try {
      for (const Key of [record.uploadKey, record.objectKey])
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.config.bucket, Key }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
    } catch {
      throw new ServiceUnavailableException('Media deletion unavailable');
    }
  }
  onModuleDestroy() {
    this.client.destroy();
  }
}
