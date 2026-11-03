import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddActivityRewards1792190000000 } from '../src/database/migrations/1792190000000-AddActivityRewards.js';
import { CompleteActivityRewards1793360000000 } from '../src/database/migrations/1793360000000-CompleteActivityRewards.js';
import { ActivateWgoTitles1793400000000 } from '../src/database/migrations/1793400000000-ActivateWgoTitles.js';
import { StoreVoteActivitySnapshots1793650000000 } from '../src/database/migrations/1793650000000-StoreVoteActivitySnapshots.js';
import type { ActivityInput } from '../src/rewards/post-event.js';

export const R1 = '1159053000',
  R2 = '1159064000';
export const NOW = new Date('2026-11-03T12:00:00+09:00');
export const eventId = () => `evt_${randomUUID()}`;
export function voteFact(
  kind: 'VOTE_CANDIDATE' | 'VOTE_WIN',
  userId = '1',
  extra: Partial<ActivityInput> = {},
): ActivityInput {
  const postId = extra.postId ?? `post_${randomUUID()}`;
  const commentId = extra.commentId ?? `comment_${randomUUID()}`;
  return {
    kind,
    postId,
    commentId,
    actorId: userId,
    beneficiaryId: userId,
    eventId: eventId(),
    correlationId: 'vote-activity-test',
    key:
      kind === 'VOTE_CANDIDATE'
        ? `candidate:${postId}:${commentId}`
        : `vote:${postId}`,
    reactionType: null,
    version: 1,
    active: true,
    regionCode: R1,
    occurredAt: '2026-11-02T12:00:00.000Z',
    ...(kind === 'VOTE_CANDIDATE'
      ? { scoreAtSelection: 999 }
      : { resultId: postId }),
    ...extra,
  };
}
export function deletion(
  fact: ActivityInput,
  kind: 'COMMENT' | 'POST' = 'COMMENT',
): ActivityInput {
  return {
    kind,
    postId: fact.postId,
    key: kind === 'POST' ? fact.postId : fact.commentId!,
    actorId: fact.actorId,
    beneficiaryId: null,
    reactionType: null,
    version: 2,
    active: false,
    eventId: eventId(),
    correlationId: 'vote-delete-test',
    ...(kind === 'POST'
      ? { postStatus: 'DELETED' }
      : { commentId: fact.commentId! }),
  };
}
export async function voteTestDatabase(
  prefix: string,
  migrateSnapshots = true,
) {
  const c = configuration().database;
  const options = {
    type: 'postgres' as const,
    host: c.host,
    port: c.port,
    username: c.username,
    password: c.password,
  };
  const name = `wgo_${prefix}_${process.pid}_${Date.now()}`;
  const admin = new DataSource({ ...options, database: 'postgres' });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${name}"`);
  const db = new DataSource({
    ...options,
    database: name,
    entities: [...USER_SERVICE_ENTITIES],
    migrations: [
      InitialUserServiceSchema1789990707351,
      AddActivityRewards1792190000000,
      CompleteActivityRewards1793360000000,
      ActivateWgoTitles1793400000000,
      ...(migrateSnapshots ? [StoreVoteActivitySnapshots1793650000000] : []),
    ],
  });
  await db.initialize();
  await db.runMigrations();
  return {
    db,
    async fresh() {
      await db.query(
        'TRUNCATE users,reward_policies,user_activities,reward_posts,reward_inbox,outbox_events,reward_post_regions,reward_post_region_history RESTART IDENTITY CASCADE',
      );
      await db.query(
        "INSERT INTO users(id,nickname,status,created_at,updated_at) SELECT i,'Vote user '||i,'ACTIVE',now(),now() FROM generate_series(1,100) i",
      );
    },
    async close() {
      await db.destroy();
      await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);
      await admin.destroy();
    },
  };
}
