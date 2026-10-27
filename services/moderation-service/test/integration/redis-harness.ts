import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

import { CommentModerationService } from '../../src/content-moderation/comment-moderation.service.js';
import type { ModerationProvider } from '../../src/content-moderation/moderation-provider.js';
import { RedisModerationResultRepository } from '../../src/content-moderation/redis-moderation-result.repository.js';
import { ModerationPostEventProcessor } from '../../src/event-consumer/moderation-post-event.processor.js';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import type { PostEventType } from '../../src/event-consumer/post-event.js';
import { LifecycleService } from '../../src/lifecycle/lifecycle.service.js';
import { RedisLifecycleRepository } from '../../src/lifecycle/redis-lifecycle.repository.js';

export const stream = 'post:events';
export const group = 'post-moderation';
export const output = 'moderation:events';
export const dead = 'moderation:post:dead';

export async function redisHarness(
  provider: ModerationProvider,
  clock = { now: () => new Date() },
) {
  // Compose 전용 Redis의 빈 DB 15만 사용한다. 기존 데이터가 있으면 삭제하지 않고 실패한다.
  const url =
    process.env.MODERATION_TEST_REDIS_URL ?? 'redis://localhost:6383/15';
  const config = new ConfigService({ redis: { url } });
  const redis = createClient({
    url,
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });
  redis.on('error', () => undefined);
  await redis.connect();
  if ((await redis.dbSize()) !== 0) {
    await redis.quit();
    throw new Error(
      'Integration Redis DB must be empty; existing data was preserved',
    );
  }
  const repository = new RedisLifecycleRepository(config);
  const results = new RedisModerationResultRepository(config);
  const lifecycle = new LifecycleService(repository);
  const moderation = new CommentModerationService(provider, results);
  const processor = new ModerationPostEventProcessor(
    moderation,
    lifecycle,
    clock,
  );
  const connection = createClient({
    url,
    socket: { reconnectStrategy: false },
  });
  const consumer = new PostEventConsumer(config, processor, connection);
  const keys = new Set([
    stream,
    output,
    dead,
    'moderation:lifecycle:posts',
    'moderation:lifecycle:due',
    'moderation:content-events',
  ]);

  function postId() {
    const id = `post_${randomUUID()}`;
    keys.add(`moderation:lifecycle:${id}`);
    return id;
  }

  function fields(
    type: PostEventType,
    id: string,
    at: string,
    content = 'A pleasant day.',
    extra: Record<string, unknown> = {},
  ) {
    const eventId = `evt_${randomUUID()}`;
    keys.add(`moderation:dedup:${eventId}`);
    keys.add(`moderation:content:${eventId}`);
    keys.add(`moderation:content-published:${eventId}`);
    // dev의 application/commands.ts payload와 outbox.worker.ts의 펼쳐진 envelope를 그대로 따른다.
    const payload =
      type === 'PostCreated'
        ? {
            post: {
              postId: id,
              authorId: 1,
              latitude: 37.5,
              longitude: 127,
              radiusM: 100,
              category: 'GENERAL',
              expiresAt: null,
            },
          }
        : type === 'PostCommentCreated'
          ? {
              comment: {
                commentId: `comment_${randomUUID()}`,
                postId: id,
                authorId: 1,
                content,
                status: 'ACTIVE',
                createdAt: at,
                updatedAt: null,
              },
            }
          : type === 'PostReactionCreated'
            ? {
                reaction: {
                  postId: id,
                  userId: 1,
                  type: 'LIKE',
                  createdAt: at,
                },
              }
            : {
                participant: {
                  postId: id,
                  userId: 1,
                  joinedAt: at,
                  lastSeenAt: at,
                  leftAt: null,
                },
              };
    const envelope = {
      eventId,
      eventType: type,
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: id,
      correlationId: `req_${randomUUID()}`,
      occurredAt: at,
      ...payload,
      ...(type === 'PostReactionRemoved'
        ? {
            activityVersion: 2,
            reaction: {
              postId: id,
              userId: 1,
              type: 'ENDED',
              createdAt: at,
              removedAt: at,
            },
          }
        : {}),
      ...(type === 'PostCommentDeleted'
        ? {
            activityVersion: 2,
            comment: {
              postId: id,
              commentId: 'comment_deleted',
              authorId: 1,
              deletedAt: at,
            },
            actor: { type: 'USER', userId: 1 },
            reason: 'USER_REQUEST',
          }
        : {}),
      ...(type === 'PostParticipantLeft'
        ? {
            activityVersion: 2,
            participant: { postId: id, userId: 1, joinedAt: at, leftAt: at },
          }
        : {}),
      ...(type === 'PostDeleted'
        ? {
            postVersion: 2,
            post: {
              postId: id,
              authorId: 1,
              category: 'GENERAL',
              deletedAt: at,
            },
            actor: { type: 'USER', userId: 1 },
            reason: 'USER_REQUEST',
          }
        : {}),
      ...(type === 'PostExpired'
        ? {
            postVersion: 2,
            post: {
              postId: id,
              authorId: 1,
              category: 'GENERAL',
              expiresAt: at,
              expiredAt: at,
            },
          }
        : {}),
      ...(type !== 'PostCreated'
        ? { postAuthorId: 1, postCategory: 'GENERAL' }
        : { postVersion: 1 }),
      ...extra,
    };
    return { eventId, eventType: type, data: JSON.stringify(envelope) };
  }

  async function prepare() {
    await connection.connect();
    await redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
  }

  async function send(message: Record<string, string>) {
    const id = await redis.xAdd(stream, '*', message);
    await consumer.pollOnce();
    return id;
  }

  async function cleanup() {
    await consumer.onModuleDestroy();
    await repository.onModuleDestroy();
    await results.onModuleDestroy();
    // FLUSHDB/FLUSHALL을 사용하지 않고 이 테스트가 소유한 key만 정리한다.
    await redis.del([...keys]);
    await redis.quit();
  }

  return {
    redis,
    repository,
    results,
    lifecycle,
    moderation,
    processor,
    consumer,
    postId,
    fields,
    prepare,
    send,
    cleanup,
  };
}
