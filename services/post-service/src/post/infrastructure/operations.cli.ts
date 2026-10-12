import 'reflect-metadata';
import { createConnection } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../../config/configuration.js';
import { PostLifecycle } from '../application/lifecycle.js';
import { HashPartitionStrategy } from '../application/partition.js';
import { MongoosePostStore } from './mongoose-post.store.js';
import {
  PostSchema,
  CommentSchema,
  ReactionSchema,
  ParticipantSchema,
  CounterSchema,
  OutboxSchema,
} from './post.schemas.js';
import { OutboxWorker } from './outbox.worker.js';
import { OutboxRecovery } from './outbox-recovery.js';

async function main() {
  const [command, id, value, extra, ...rest] = process.argv.slice(2);
  const arity: Record<string, number> = {
    'outbox-failed': 0,
    'outbox-retry': 2,
    'schedule-expiration': 2,
    expire: 1,
    'moderate-post': 2,
    'moderate-comment': 3,
  };
  const args = [id, value, extra, ...rest].filter((arg) => arg !== undefined);
  if (
    !command ||
    arity[command] === undefined ||
    arity[command] !== args.length
  )
    throw new Error(
      'Usage: post:operations outbox-failed | outbox-retry <eventId> <reason> | schedule-expiration <postId> <ISO-date> | expire <postId> | moderate-post <postId> <decisionId> | moderate-comment <postId> <commentId> <decisionId>',
    );
  if (!command.startsWith('outbox') && !/^post_[0-9a-f-]{36}$/.test(id!))
    throw new Error('Invalid post ID');
  if (command === 'moderate-comment' && !/^comment_[0-9a-f-]{36}$/.test(value!))
    throw new Error('Invalid comment ID');
  const deadline = command === 'schedule-expiration' ? new Date(value!) : null;
  if (
    deadline &&
    (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value!) ||
      !Number.isFinite(deadline.getTime()))
  )
    throw new Error('Expiration must be an ISO timestamp with timezone');
  const config = configuration();
  const db = createConnection(config.database.uri, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await db.asPromise();
    const outbox = db.model('Outbox', OutboxSchema, 'outbox_events');
    const recovery = new OutboxRecovery(outbox);
    if (command === 'outbox-failed') {
      console.info(JSON.stringify(await recovery.failed(), null, 2));
      return;
    }
    if (command === 'outbox-retry') {
      await recovery.retry(id!, value!);
      console.info({ eventId: id, status: 'PENDING' });
      return;
    }
    // CLI는 Redis나 모델을 시작하지 않는다. 커밋한 Outbox는 서비스 Worker가 발행한다.
    const store = new MongoosePostStore(
      db,
      db.model('Post', PostSchema, 'posts'),
      db.model('Comment', CommentSchema, 'post_comments'),
      db.model('Reaction', ReactionSchema, 'post_reactions'),
      db.model('Participant', ParticipantSchema, 'post_participants'),
      outbox,
      db.model('Counter', CounterSchema, 'post_counters'),
      new ConfigService(config),
      { wake() {} } as OutboxWorker,
    );
    const lifecycle = new PostLifecycle(store, new HashPartitionStrategy());
    if (command === 'schedule-expiration')
      await lifecycle.scheduleExpiration(id!, deadline!);
    if (command === 'expire') await lifecycle.expire(id!);
    if (command === 'moderate-post') await lifecycle.moderatePost(id!, value!);
    if (command === 'moderate-comment')
      await lifecycle.moderateComment(id!, value!, extra!);
    console.info({ command, postId: id, completed: true });
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
