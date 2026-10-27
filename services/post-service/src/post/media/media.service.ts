import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { S3MediaStorage } from './s3-media.storage.js';
import {
  MEDIA_ID,
  MEDIA_TYPES,
  type MediaContentType,
} from './media.policy.js';
import type { MediaRecord } from './media.schema.js';

export function mediaId(value: string) {
  if (!MEDIA_ID.test(value)) throw new BadRequestException('Invalid mediaId');
  return value;
}
@Injectable()
export class MediaService {
  constructor(
    @InjectModel('Media') readonly records: Model<MediaRecord>,
    readonly storage: S3MediaStorage,
  ) {}
  async initiate(ownerId: number, input: unknown) {
    this.storage.requireEnabled();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('JSON object required');
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (k) => !['contentType', 'sizeBytes', 'checksum'].includes(k),
      ) ||
      !MEDIA_TYPES.includes(body.contentType as MediaContentType)
    )
      throw new BadRequestException('Unsupported media contentType or field');
    const contentType = body.contentType as MediaContentType;
    const type = contentType.startsWith('image/') ? 'IMAGE' : 'VIDEO';
    const max =
      type === 'IMAGE'
        ? this.storage.config.imageBytes
        : this.storage.config.videoBytes;
    if (
      typeof body.sizeBytes !== 'number' ||
      !Number.isSafeInteger(body.sizeBytes) ||
      body.sizeBytes < 1 ||
      body.sizeBytes > max
    )
      throw new BadRequestException(`sizeBytes must be between 1 and ${max}`);
    if (
      typeof body.checksum !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(body.checksum) ||
      Buffer.from(body.checksum, 'base64').toString('base64') !== body.checksum
    )
      throw new BadRequestException('checksum must be a base64 SHA-256 digest');
    const id = `media_${randomUUID()}`;
    const record: MediaRecord = {
      mediaId: id,
      ownerId,
      type,
      contentType,
      sizeBytes: body.sizeBytes,
      checksum: body.checksum,
      objectKey: `post-media/objects/${id}`,
      uploadKey: `post-media/pending/${id}`,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    };
    const upload = await this.storage.upload(record);
    await this.records.create(record);
    return {
      mediaId: id,
      status: record.status,
      upload,
      attachmentExpiresAt: record.expiresAt.toISOString(),
    };
  }
  async status(ownerId: number, id: string) {
    const record = await this.owned(ownerId, id);
    return {
      mediaId: record.mediaId,
      status: record.status,
      type: record.type,
      attachmentExpiresAt: record.expiresAt.toISOString(),
    };
  }
  private async owned(ownerId: number, id: string) {
    const record = await this.records
      .findOne({ mediaId: mediaId(id), ownerId })
      .lean();
    if (!record) throw new NotFoundException('Media not found');
    return record;
  }
  async complete(ownerId: number, id: string) {
    const record = await this.owned(ownerId, id);
    if (
      record.status === 'ATTACHED' ||
      (record.status === 'READY' && record.expiresAt > new Date())
    )
      return { mediaId: id, status: record.status };
    if (record.status !== 'PENDING' || record.expiresAt <= new Date())
      throw new ConflictException('Upload is no longer available');
    await this.storage.verifyAndPromote(record);
    const ready = await this.records
      .findOneAndUpdate(
        {
          mediaId: id,
          ownerId,
          status: 'PENDING',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'READY', verifiedAt: new Date() } },
        { new: true },
      )
      .lean();
    if (!ready) {
      const latest = await this.owned(ownerId, id);
      if (
        !['READY', 'ATTACHED'].includes(latest.status) ||
        (latest.status === 'READY' && latest.expiresAt <= new Date())
      )
        throw new ConflictException('Upload is no longer available');
      return { mediaId: id, status: latest.status };
    }
    return { mediaId: id, status: ready.status };
  }
  async cancel(ownerId: number, id: string) {
    const record = await this.owned(ownerId, id);
    if (record.status === 'ATTACHED')
      throw new ConflictException(
        'Attached media cannot be cancelled; delete its post or comment',
      );
    if (record.status === 'DELETING') return;
    const result = await this.records.updateOne(
      { mediaId: id, ownerId, status: { $in: ['PENDING', 'READY'] } },
      {
        $set: { status: 'DELETING', cleanupAt: new Date(Date.now() + 300000) },
      },
    );
    if (!result.modifiedCount) {
      const latest = await this.owned(ownerId, id);
      if (latest.status !== 'DELETING')
        throw new ConflictException('Media state changed');
    }
  }
  // 조회의 공개 범위는 기존 ACTIVE 게시물/댓글 정책을 따른다. 원본 조회 후에만 호출한다.
  async forTargets(
    targets: { postId: string; commentId?: string; mediaIds?: string[] }[],
  ) {
    const ids = [...new Set(targets.flatMap((t) => t.mediaIds ?? []))];
    if (!ids.length) return targets.map(() => []);
    const records = await this.records
      .find({ mediaId: { $in: ids }, status: 'ATTACHED' })
      .lean();
    const byId = new Map(records.map((r) => [r.mediaId, r]));
    const result = [];
    for (const target of targets) {
      const media = [];
      for (const id of target.mediaIds ?? []) {
        const record = byId.get(id);
        if (
          !record ||
          record.postId !== target.postId ||
          (record.commentId ?? undefined) !== target.commentId
        )
          throw new NotFoundException('Attached media not found');
        media.push(await this.storage.read(record));
      }
      result.push(media);
    }
    return result;
  }
}
