import { createLogger } from '../../observability/logging.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { UserEntity, UserStatus } from '../../database/entities/user.entity.js';
import { UserBlockEntity } from '../../database/entities/user-block.entity.js';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity.js';
import { ProfileImageUploadEntity } from '../../database/entities/profile-image-upload.entity.js';
import { GcsProfileImageStorage } from './gcs-profile-image.storage.js';
import {
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  IMAGE_UPLOAD_ID,
  IMAGE_URL_SECONDS,
} from './profile-image.config.js';

const CLEANUP_GRACE_MS = 15 * 60 * 1000;
const RECHECK_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ProfileImageService {
  private readonly logger = createLogger('user-service', 'profile-image');
  constructor(
    @InjectDataSource() readonly database: DataSource,
    readonly storage: GcsProfileImageStorage,
  ) {}

  async initiate(ownerId: string, input: unknown) {
    const body = parseUpload(input);
    this.storage.requireEnabled();
    const record = await this.database.transaction(async (manager) => {
      await activeOwner(manager, ownerId);
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + IMAGE_URL_SECONDS * 1000);
      const uploads = manager.getRepository(ProfileImageUploadEntity);
      return uploads.save(
        uploads.create({
          id,
          ownerId,
          ...body,
          uploadKey: `user-profiles/pending/${id}`,
          objectKey: `user-profiles/objects/${id}`,
          status: 'PENDING',
          createdAt: now,
          expiresAt,
          verifiedAt: null,
          appliedAt: null,
          retiredAt: null,
          cleanupAt: new Date(expiresAt.getTime() + CLEANUP_GRACE_MS),
        }),
      );
    });
    // Persist before signing; even a lost signing response leaves a cleanup record.
    return this.storage.upload(record);
  }

  async complete(
    ownerId: string,
    id: string,
    correlationId: string = randomUUID(),
  ) {
    if (!IMAGE_UPLOAD_ID.test(id))
      throw new BadRequestException('Invalid uploadId');
    this.storage.requireEnabled();
    await this.database.transaction(async (manager) => {
      await activeOwner(manager, ownerId);
      const upload = await ownedUpload(manager, ownerId, id);
      if (upload.status === 'APPLIED') return;
      available(upload);
      if (upload.status === 'VERIFIED') return;
      // All complete/cleanup operations lock owner then upload. Holding these locks
      // through bounded GCS calls also prevents cleanup racing a promotion.
      await this.storage.verifyAndPromote(upload);
      available(upload);
      upload.status = 'VERIFIED';
      upload.verifiedAt = new Date();
      await manager.getRepository(ProfileImageUploadEntity).save(upload);
    });
    // A crash here leaves VERIFIED recoverable by the same complete request.
    return this.database.transaction(async (manager) => {
      const user = await activeOwner(manager, ownerId);
      const upload = await ownedUpload(manager, ownerId, id);
      if (upload.status !== 'APPLIED') {
        available(upload);
        if (upload.status !== 'VERIFIED')
          throw new ConflictException('Upload is not verified');
        const now = new Date();
        user.profileImageKey = upload.objectKey;
        user.updatedAt = now;
        await manager.getRepository(UserEntity).save(user);
        upload.status = 'APPLIED';
        upload.appliedAt = now;
        await manager.getRepository(ProfileImageUploadEntity).save(upload);
        if (user.onboardingCompletedAt) {
          const eventId = randomUUID();
          await manager.getRepository(OutboxEventEntity).insert({
            eventId,
            aggregateId: ownerId,
            eventType: 'USER_PROFILE_UPDATED',
            payload: {
              eventId,
              type: 'USER_PROFILE_UPDATED',
              target: { type: 'USER', id: ownerId },
              occurredAt: now.toISOString(),
              version: 1,
              producer: 'user-service',
              correlationId,
              payload: {
                userId: ownerId,
                nickname: user.nickname,
                profileImageKey: user.profileImageKey,
              },
            },
            status: 'PENDING',
            publishAttempts: 0,
            createdAt: now,
            publishedAt: null,
          });
        }
      }
      // Replays acknowledge the historical operation, never restore a replaced/removed image.
      return {
        uploadId: id,
        status: 'APPLIED' as const,
        profileImageKey: upload.objectKey,
        isCurrent: user.profileImageKey === upload.objectKey,
      };
    });
  }

  async read(requesterId: string, targetId = requesterId) {
    return this.database.transaction(async (manager) => {
      // Same sorted owner locks as block creation: authorization cannot race a new block.
      const users = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('user')
        .where('user.id IN (:...ids)', { ids: [requesterId, targetId] })
        .orderBy('user.id', 'ASC')
        .setLock('pessimistic_read')
        .getMany();
      const requester = users.find((u) => u.id === requesterId);
      if (!requester) throw new NotFoundException('User not found');
      if (requester.status !== UserStatus.ACTIVE)
        throw new ForbiddenException('Active account required');
      const target = users.find((u) => u.id === targetId);
      if (
        !target ||
        (targetId !== requesterId &&
          (target.status !== UserStatus.ACTIVE ||
            !target.onboardingCompletedAt))
      )
        throw new NotFoundException('Profile image not found');
      if (
        targetId !== requesterId &&
        (await manager.getRepository(UserBlockEntity).exists({
          where: [
            { blockerUserId: requesterId, blockedUserId: targetId },
            { blockerUserId: targetId, blockedUserId: requesterId },
          ],
        }))
      )
        throw new NotFoundException('Profile image not found');
      if (!target.profileImageKey)
        return { profileImageKey: null, url: null, expiresAt: null };
      return this.storage.read(target.profileImageKey);
    });
  }

  async cleanup() {
    this.storage.requireEnabled();
    const rows = await this.database
      .getRepository(ProfileImageUploadEntity)
      .createQueryBuilder('upload')
      .where('upload.cleanupAt <= :now', { now: new Date() })
      .orderBy('upload.cleanupAt', 'ASC')
      .take(20)
      .getMany();
    for (const row of rows) {
      try {
        const cleaned = await this.database.transaction(async (manager) => {
          await manager.getRepository(UserEntity).findOne({
            where: { id: row.ownerId },
            lock: { mode: 'pessimistic_write' },
          });
          const upload = await ownedUpload(manager, row.ownerId, row.id);
          const now = new Date();
          if (upload.cleanupAt > now) return;
          if (upload.status !== 'APPLIED' && upload.expiresAt <= now)
            upload.status = 'EXPIRED';
          if (upload.status !== 'APPLIED' && upload.status !== 'EXPIRED')
            return;
          await this.storage.remove(upload, 'pending');
          // Only managed, irreversible uploads are collected. Legacy keys have no record.
          // A defensive global reference check preserves even pre-existing shared keys.
          const referenced = await manager
            .getRepository(UserEntity)
            .existsBy({ profileImageKey: upload.objectKey });
          if (
            !referenced &&
            upload.retiredAt &&
            upload.retiredAt.getTime() + CLEANUP_GRACE_MS <= now.getTime()
          )
            await this.storage.remove(upload, 'object');
          else if (!referenced && !upload.retiredAt) upload.retiredAt = now;
          else if (referenced) upload.retiredAt = null;
          // Keep tombstones and reconcile again: remote copies/PUTs can finish after
          // a timeout or process death. No DB failure can permanently orphan a known key.
          upload.cleanupAt = new Date(
            now.getTime() +
              (!referenced && upload.retiredAt?.getTime() === now.getTime()
                ? CLEANUP_GRACE_MS
                : RECHECK_MS),
          );
          await manager.getRepository(ProfileImageUploadEntity).save(upload);
          return true;
        });
        if (cleaned)
          this.logger.success(
            'profile_cleanup_completed',
            'Profile image cleanup reconciled',
            { uploadId: row.id },
          );
        else
          this.logger.skipped('profile_cleanup_skipped', 'NOT_DUE', {
            uploadId: row.id,
          });
      } catch (error) {
        // One inaccessible object must not starve later cleanup records.
        await this.database
          .getRepository(ProfileImageUploadEntity)
          .update(row.id, { cleanupAt: new Date(Date.now() + 60000) });
        this.logger.failure(
          'profile_cleanup_deferred',
          error,
          'PROFILE_CLEANUP_FAILED',
          'Profile cleanup deferred; retained for retry',
          { uploadId: row.id },
          true,
        );
      }
    }
  }
}

async function activeOwner(manager: EntityManager, id: string) {
  const user = await manager
    .getRepository(UserEntity)
    .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!user) throw new NotFoundException('User not found');
  if (user.status !== UserStatus.ACTIVE)
    throw new ForbiddenException('Active account required');
  return user;
}
async function ownedUpload(
  manager: EntityManager,
  ownerId: string,
  id: string,
) {
  const upload = await manager
    .getRepository(ProfileImageUploadEntity)
    .findOne({ where: { id, ownerId }, lock: { mode: 'pessimistic_write' } });
  if (!upload) throw new NotFoundException('Upload not found');
  return upload;
}
function available(upload: ProfileImageUploadEntity) {
  if (upload.status === 'EXPIRED' || upload.expiresAt <= new Date())
    throw new ConflictException('Upload expired');
}
export function parseUpload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('JSON object required');
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (k) => !['contentType', 'sizeBytes', 'checksum'].includes(k),
    ) ||
    !IMAGE_TYPES.includes(body.contentType as (typeof IMAGE_TYPES)[number])
  )
    throw new BadRequestException('Unsupported contentType or field');
  if (
    typeof body.sizeBytes !== 'number' ||
    !Number.isSafeInteger(body.sizeBytes) ||
    body.sizeBytes < 1 ||
    body.sizeBytes > IMAGE_MAX_BYTES
  )
    throw new BadRequestException(
      `sizeBytes must be between 1 and ${IMAGE_MAX_BYTES}`,
    );
  if (
    typeof body.checksum !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(body.checksum) ||
    Buffer.from(body.checksum, 'base64').toString('base64') !== body.checksum
  )
    throw new BadRequestException('checksum must be a base64 SHA-256 digest');
  return {
    contentType: body.contentType as string,
    sizeBytes: body.sizeBytes,
    checksum: body.checksum,
  };
}
